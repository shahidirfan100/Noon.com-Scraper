// Noon.com product scraper - Production-grade implementation
// Uses internal API (JSON) as primary source with HTML fallback
import { Actor, log } from 'apify';
import { CheerioCrawler, Dataset } from 'crawlee';
import { gotScraping } from 'got-scraping';
import { HeaderGenerator } from 'header-generator';
import { load as loadHtml } from 'cheerio';

// Single-entrypoint main
await Actor.init();

// Initialize header generator for stealth
const headerGenerator = new HeaderGenerator({
    browsers: [
        { name: 'chrome', minVersion: 120 },
        { name: 'firefox', minVersion: 120 },
        { name: 'safari', minVersion: 17 }
    ],
    devices: ['desktop'],
    locales: ['en-US', 'en-GB'],
    operatingSystems: ['windows', 'macos']
});

async function main() {
    try {
        const input = (await Actor.getInput()) || {};
        const {
            startUrl,
            startUrls,
            url,
            maxProducts = 100,
            maxPages = 10,
            fetchDetails = false, // enable detail-page enrichment (slower)
            detailSampleLimit = 10, // limit number of detail fetches for speed
            proxyConfiguration,
        } = input;

        const MAX_PRODUCTS = Number.isFinite(+maxProducts) ? Math.max(1, +maxProducts) : 100;
        const MAX_PAGES = Number.isFinite(+maxPages) ? Math.max(1, +maxPages) : 10;

        log.info(`Starting scraper: maxProducts=${MAX_PRODUCTS}, maxPages=${MAX_PAGES}`);

        const toAbs = (href, base = 'https://www.noon.com') => {
            try { return new URL(href, base).href; } catch { return null; }
        };

        const cleanText = (text) => {
            if (!text) return '';
            return String(text).replace(/\s+/g, ' ').trim();
        };

        const cleanPrice = (priceText) => {
            if (!priceText) return null;
            const match = String(priceText).match(/[\d,]+(\.\d+)?/);
            return match ? parseFloat(match[0].replace(/,/g, '')) : null;
        };

        const initial = [];
        if (Array.isArray(startUrls) && startUrls.length) {
            initial.push(...startUrls.map(u => typeof u === 'string' ? u : u.url));
        }
        if (startUrl) initial.push(startUrl);
        if (url) initial.push(url);
        if (!initial.length) {
            initial.push('https://www.noon.com/uae-en/fashion/men-31225/crazy-price-drops-ae-FA_03/');
        }

        const proxyConf = proxyConfiguration ? await Actor.createProxyConfiguration({ ...proxyConfiguration }) : undefined;

        let saved = 0;
        let pageCount = 0;
        const errors = [];

        // ==========================================
        // API-BASED SCRAPING (PRIMARY METHOD)
        // ==========================================
        
        /**
         * Extract product data from API response
         * Noon.com uses GraphQL/REST API for product listings
         */
        function extractProductFromAPI(product) {
            try {
                // Validate required fields
                if (!product || !product.sku) {
                    return null;
                }

                const sku = product.sku || product.product_code || product.id;
                const url = product.url || product.product_url || 
                           (sku ? `https://www.noon.com/uae-en/p/${sku}` : null);

                return {
                    title: cleanText(product.name || product.title || product.product_name),
                    url: url ? toAbs(url) : null,
                    image: product.image_url || product.image || product.thumbnail || null,
                    brand: cleanText(product.brand || product.brand_name) || null,
                    description: cleanText(product.description || product.overview || product.summary) || null,
                    currentPrice: cleanPrice(product.sale_price || product.price || product.offer_price),
                    originalPrice: cleanPrice(product.was_price || product.list_price || product.original_price),
                    discount: product.discount_percentage || product.discount || null,
                    rating: product.rating || product.average_rating || null,
                    reviewsCount: product.reviews_count || product.rating_count || null,
                    sku: sku,
                    currency: product.currency || 'AED',
                    scrapedAt: new Date().toISOString(),
                };
            } catch (err) {
                log.error(`Error extracting API product: ${err.message}`);
                return null;
            }
        }

        /**
         * Try to fetch products via API (primary method)
         * Noon.com loads products via AJAX/API calls
         */
        async function fetchProductsViaAPI(catalogUrl, page = 1) {
            try {
                log.info(`[API] Attempting to fetch products from API - Page ${page}`);
                
                // Parse catalog URL to extract parameters
                const urlObj = new URL(catalogUrl);
                const pathParts = urlObj.pathname.split('/').filter(Boolean);
                
                // Extract catalog/category info from URL
                // Example: /uae-en/fashion/men-31225/crazy-price-drops-ae-FA_03/
                const lang = pathParts[0] || 'uae-en';
                const category = pathParts[pathParts.length - 2] || '';
                
                // Generate realistic headers
                const headers = headerGenerator.getHeaders({
                    httpVersion: '2',
                    locales: ['en-US', 'en-AE'],
                    operatingSystems: ['windows'],
                    browsers: ['chrome']
                });

                // Noon.com API endpoint patterns (common possibilities)
                const apiEndpoints = [
                    // Pattern 1: Direct catalog API
                    `https://www.noon.com/api/catalog/v1/u/${lang}/products?${urlObj.search.substring(1)}&page=${page}&limit=50`,
                    // Pattern 2: Search/filter API
                    `https://www.noon.com/${lang}/api/search?${urlObj.search.substring(1)}&page=${page}`,
                    // Pattern 3: Category products API
                    `https://api.noon.com/catalog/products?category=${category}&page=${page}&limit=50`,
                ];

                // Try each API endpoint with retries
                for (const apiUrl of apiEndpoints) {
                    try {
                        log.info(`[API] Trying endpoint: ${apiUrl}`);
                        
                        const response = await gotScraping({
                            url: apiUrl,
                            method: 'GET',
                            headers: {
                                ...headers,
                                'accept': 'application/json, text/plain, */*',
                                'accept-language': 'en-US,en;q=0.9',
                                'referer': catalogUrl,
                                'origin': 'https://www.noon.com',
                                'x-requested-with': 'XMLHttpRequest',
                                'connection': 'keep-alive',
                            },
                            http2: true,
                            responseType: 'json',
                            timeout: { request: 20000 },
                            retry: { limit: 2, methods: ['GET'] },
                            proxyUrl: proxyConf ? await proxyConf.newUrl() : undefined,
                        });

                        if (response.body && typeof response.body === 'object') {
                            log.info(`[API] Success! Got response from: ${apiUrl}`);
                            
                            // Try to extract products from various response structures
                            let products = [];
                            const data = response.body;
                            
                            // Common API response structures
                            if (data.products && Array.isArray(data.products)) {
                                products = data.products;
                            } else if (data.data && Array.isArray(data.data.products)) {
                                products = data.data.products;
                            } else if (data.hits && Array.isArray(data.hits)) {
                                products = data.hits;
                            } else if (data.results && Array.isArray(data.results)) {
                                products = data.results;
                            } else if (Array.isArray(data)) {
                                products = data;
                            }

                            if (products.length > 0) {
                                log.info(`[API] Extracted ${products.length} products from API`);
                                
                                // Extract pagination info
                                const pagination = {
                                    hasNext: false,
                                    totalPages: data.total_pages || data.totalPages || MAX_PAGES,
                                    currentPage: page,
                                };
                                
                                if (data.pagination) {
                                    pagination.hasNext = data.pagination.has_next || page < pagination.totalPages;
                                } else if (data.next || data.nextPage) {
                                    pagination.hasNext = true;
                                }

                                return {
                                    success: true,
                                    products: products.map(p => extractProductFromAPI(p)).filter(Boolean),
                                    pagination,
                                };
                            }
                        }
                    } catch (apiErr) {
                        log.debug(`[API] Endpoint failed: ${apiUrl} - ${apiErr.message}`);
                        continue;
                    }
                }

                log.warning('[API] All API endpoints failed, will try HTML parsing');
                return { success: false, products: [], pagination: {} };

            } catch (err) {
                log.error(`[API] Fatal error in API fetch: ${err.message}`);
                return { success: false, products: [], pagination: {} };
            }
        }

        // ==========================================
        // HTML PARSING (FALLBACK METHOD)
        // ==========================================
        
        function extractProductData($, productElement, baseUrl) {
            try {
                const $product = $(productElement);
                
                // Product URL
                const productLink = $product.find('a[href*="/p/"]').first();
                const productUrl = productLink.attr('href');
                const fullUrl = productUrl ? toAbs(productUrl, baseUrl) : null;
                
                if (!fullUrl) return null;
                
                // Product Title
                const title = cleanText(
                    $product.find('[data-qa="product-name"]').text() ||
                    $product.find('[class*="title"]').text() ||
                    $product.find('h2, h3').first().text() ||
                    productLink.attr('title')
                );
                
                if (!title) return null;
                
                // Product Image
                const imageElement = $product.find('img').first();
                const image = imageElement.attr('src') || 
                            imageElement.attr('data-src') || 
                            imageElement.attr('srcset')?.split(' ')[0] || null;
                
                // Price information
                const currentPriceText = $product.find('[class*="sellingPrice"], [class*="price"]').first().text();
                const originalPriceText = $product.find('[class*="oldPrice"], [class*="wasPrice"]').first().text();
                const discountText = $product.find('[class*="discount"], [class*="OFF"]').first().text();
                
                const currentPrice = cleanPrice(currentPriceText);
                const originalPrice = cleanPrice(originalPriceText);
                const discount = discountText ? cleanText(discountText) : null;
                
                // Rating
                const ratingText = $product.find('[class*="rating"]').first().text();
                const rating = ratingText ? parseFloat(ratingText) : null;
                
                // Reviews count
                const reviewsText = $product.find('[class*="reviews"], [class*="rating"]').text();
                const reviewsMatch = reviewsText.match(/\d+/);
                const reviews = reviewsMatch ? parseInt(reviewsMatch[0]) : null;
                
                // Brand
                const brand = cleanText($product.find('[class*="brand"]').text()) || null;
                
                // Product SKU/ID from URL
                const skuMatch = fullUrl ? fullUrl.match(/\/([A-Z0-9]+)\/p\//) : null;
                const sku = skuMatch ? skuMatch[1] : null;

                return {
                    title: title,
                    url: fullUrl,
                    image: image,
                    brand: brand,
                    description: null, // filled via detail page enrichment if available
                    currentPrice: currentPrice,
                    originalPrice: originalPrice,
                    discount: discount,
                    rating: rating,
                    reviewsCount: reviews,
                    sku: sku,
                    currency: 'AED',
                    scrapedAt: new Date().toISOString(),
                };
            } catch (err) {
                log.error(`Error extracting HTML product: ${err.message}`);
                return null;
            }
        }

        /**
         * Validate product data before saving
         */
        function validateProduct(product) {
            if (!product) return false;
            
            // Required fields
            if (!product.title || !product.url) {
                log.warning(`⚠️ Invalid product: missing required fields (title or url)`);
                return false;
            }

            // Title validation
            if (product.title.length < 5 || product.title.length > 500) {
                log.warning(`⚠️ Invalid product: title length out of range`);
                return false;
            }

            return true;
        }

        /**
         * Enrich product by fetching its detail page for missing fields
         * Targets: description, brand, rating, reviewsCount
         */
        async function enrichProductWithDetails(product) {
            if (!product?.url) return product;

            const needsDetail = !product.description || !product.brand || !product.rating || !product.reviewsCount;
            if (!needsDetail) return product;

            try {
                const headers = headerGenerator.getHeaders({ httpVersion: '2', locales: ['en-US', 'en-AE'] });
                const resp = await gotScraping({
                    url: product.url,
                    method: 'GET',
                    headers: {
                        ...headers,
                        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                        'accept-language': 'en-US,en;q=0.9',
                        'upgrade-insecure-requests': '1',
                        'sec-fetch-site': 'none',
                        'sec-fetch-mode': 'navigate',
                        'sec-fetch-dest': 'document',
                    },
                    timeout: { request: 30000 },
                    retry: { limit: 2 },
                    proxyUrl: proxyConf ? await proxyConf.newUrl() : undefined,
                });

                const $ = loadHtml(resp.body);

                const description = cleanText(
                    $('.OverviewTab-module-scss-module__NTeOuq__row').text() ||
                    $('[data-qa*="overview"]').text() ||
                    $('section:contains("Overview")').text()
                ) || product.description;

                const brand = cleanText(
                    $('span.BrandStoreCtaV2-module-scss-module___vJ0Tq__textContent.BrandStoreCtaV2-module-scss-module___vJ0Tq__brandStoreText').text() ||
                    $('a[aria-label*="brand"], a[href*="brand"] span').first().text()
                ) || product.brand;

                const ratingText = cleanText(
                    $('div.NoonRatings-module-scss-module__ABB9HW__overallRating').first().text() ||
                    $('[data-qa*="rating"]').first().text()
                );
                const rating = ratingText ? parseFloat(ratingText) : product.rating;

                const reviewsText = cleanText(
                    $('div.ProductReviewsFilters-module-scss-module__hOBdza__reviewTopicInner').first().text() ||
                    $('[data-qa*="reviews"]').first().text()
                );
                const reviewsMatch = reviewsText.match(/\d+/);
                const reviewsCount = reviewsMatch ? parseInt(reviewsMatch[0]) : product.reviewsCount;

                return {
                    ...product,
                    description: description || product.description || null,
                    brand: brand || product.brand || null,
                    rating: rating ?? product.rating ?? null,
                    reviewsCount: reviewsCount ?? product.reviewsCount ?? null,
                };
            } catch (err) {
                log.warning(`Detail fetch failed for ${product.url}: ${err.message}`);
                return product;
            }
        }


        // ==========================================
        // CRAWLER SETUP WITH DUAL APPROACH
        // ==========================================

        const crawler = new CheerioCrawler({
            proxyConfiguration: proxyConf,
            maxRequestRetries: 5,
            useSessionPool: true,
            sessionPoolOptions: {
                maxPoolSize: 50,
                sessionOptions: {
                    maxUsageCount: 10,
                    maxErrorScore: 3,
                },
            },
            maxConcurrency: 6, // slightly higher for speed with API-first
            minConcurrency: 2,
            requestHandlerTimeoutSecs: 120,
            navigationTimeoutSecs: 60,
            
            // Add moderate rate limit for stealth
            maxRequestsPerMinute: 60,
            
            // Pre-navigation hook to add stealth headers
            preNavigationHooks: [
                async ({ request, session }, gotoOptions) => {
                    const stealthHeaders = headerGenerator.getHeaders({
                        httpVersion: '2',
                        locales: ['en-US', 'en-AE'],
                    });
                    
                    gotoOptions.headers = {
                        ...gotoOptions.headers,
                        ...stealthHeaders,
                        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                        'accept-language': 'en-US,en;q=0.9',
                        'cache-control': 'max-age=0',
                        'sec-fetch-dest': 'document',
                        'sec-fetch-mode': 'navigate',
                        'sec-fetch-site': 'none',
                        'upgrade-insecure-requests': '1',
                    };
                },
            ],
            
            async requestHandler({ request, $, crawler, log: crawlerLog }) {
                const label = request.userData?.label || 'LIST';
                const currentPage = request.userData?.page || 1;

                if (label === 'LIST') {
                    pageCount++;
                    crawlerLog.info(`📄 Processing page ${currentPage} (${pageCount}/${MAX_PAGES}): ${request.url}`);

                    let productsToSave = [];
                    
                    // ========================================
                    // STEP 1: Try API first (PRIMARY METHOD)
                    // ========================================
                    const apiResult = await fetchProductsViaAPI(request.url, currentPage);
                    
                    if (apiResult.success && apiResult.products.length > 0) {
                        crawlerLog.info(`✅ [API] Successfully fetched ${apiResult.products.length} products from API`);
                        productsToSave = apiResult.products;
                        
                        // Queue next page if available
                        if (apiResult.pagination.hasNext && pageCount < MAX_PAGES && saved < MAX_PRODUCTS) {
                            const nextPageNum = currentPage + 1;
                            const nextUrl = new URL(request.url);
                            nextUrl.searchParams.set('page', String(nextPageNum));
                            
                            await crawler.addRequests([{
                                url: nextUrl.href,
                                userData: { label: 'LIST', page: nextPageNum },
                            }]);
                            
                            crawlerLog.info(`➡️ [API] Queued next page: ${nextPageNum}`);
                        }
                    } 
                    // ========================================
                    // STEP 2: Fallback to HTML parsing
                    // ========================================
                    else {
                        crawlerLog.warning('⚠️ [API] Failed, falling back to HTML parsing');
                        
                        // Try multiple selectors for product containers
                        const productSelectors = [
                            '[data-qa="product-box"]',
                            '[data-qa*="product"]',
                            '[class*="productContainer"]',
                            '[class*="ProductCard"]',
                            '[class*="product-card"]',
                            'div[class*="sc-"] a[href*="/p/"]',
                            'article[class*="product"]',
                        ];
                        
                        let $products = null;
                        for (const selector of productSelectors) {
                            const found = $(selector);
                            if (found.length > 0) {
                                $products = found;
                                crawlerLog.info(`✅ [HTML] Found ${found.length} products using selector: ${selector}`);
                                break;
                            }
                        }
                        
                        if (!$products || $products.length === 0) {
                            crawlerLog.error(`❌ No products found on ${request.url}`);
                            crawlerLog.error(`Page content sample: ${$.html().substring(0, 500)}`);
                            
                            // Check if we hit a block/captcha page
                            const bodyText = $('body').text().toLowerCase();
                            if (bodyText.includes('captcha') || bodyText.includes('blocked')) {
                                crawlerLog.error('🚫 Detected CAPTCHA or block page');
                                errors.push({ page: currentPage, error: 'CAPTCHA/Block detected' });
                            }
                            return;
                        }

                        crawlerLog.info(`📦 [HTML] Processing ${$products.length} product elements`);

                        $products.each((_, productEl) => {
                            if (saved >= MAX_PRODUCTS) return false;
                            
                            const productData = extractProductData($, productEl, request.url);
                            if (productData && validateProduct(productData)) {
                                productsToSave.push(productData);
                            }
                        });

                        // HTML pagination
                        if (saved < MAX_PRODUCTS && pageCount < MAX_PAGES) {
                            // Look for next page link
                            const nextPageLink = $('a[aria-label*="next"]').first().attr('href') ||
                                               $('a[class*="next"]').first().attr('href') ||
                                               $(`a:contains("${currentPage + 1}")`).first().attr('href');
                            
                            if (nextPageLink) {
                                const nextUrl = toAbs(nextPageLink, request.url);
                                await crawler.addRequests([{
                                    url: nextUrl,
                                    userData: { label: 'LIST', page: currentPage + 1 },
                                }]);
                                crawlerLog.info(`➡️ [HTML] Queued next page: ${nextUrl}`);
                            } else {
                                // Try constructing next page URL
                                const nextUrl = new URL(request.url);
                                nextUrl.searchParams.set('page', String(currentPage + 1));
                                
                                await crawler.addRequests([{
                                    url: nextUrl.href,
                                    userData: { label: 'LIST', page: currentPage + 1 },
                                }]);
                                
                                crawlerLog.info(`➡️ [HTML] Constructed next page URL: ${nextUrl.href}`);
                            }
                        }
                    }

                    // ========================================
                    // STEP 3: Save validated products
                    // ========================================
                    if (productsToSave.length > 0) {
                        const validProducts = productsToSave.filter(validateProduct).slice(0, MAX_PRODUCTS - saved);

                        // Enrich products with detail page data where needed (optional for speed)
                        const enrichedProducts = [];
                        let detailFetched = 0;
                        for (const prod of validProducts) {
                            if (fetchDetails && detailFetched < detailSampleLimit) {
                                const enriched = await enrichProductWithDetails(prod);
                                enrichedProducts.push(enriched);
                                detailFetched += 1;
                            } else {
                                enrichedProducts.push(prod);
                            }
                        }

                        if (enrichedProducts.length > 0) {
                            await Dataset.pushData(enrichedProducts);
                            saved += enrichedProducts.length;
                            crawlerLog.info(`💾 Saved ${enrichedProducts.length} products (Total: ${saved}/${MAX_PRODUCTS})`);
                            
                            // Log sample product for verification
                            crawlerLog.debug(`Sample product: ${JSON.stringify(enrichedProducts[0], null, 2)}`);
                        }
                    } else {
                        crawlerLog.warning('⚠️ No valid products to save from this page');
                    }

                    // Add small delay between requests (faster)
                    await new Promise(resolve => setTimeout(resolve, 250 + Math.random() * 750));
                }
            },
            
            // Enhanced error handling (Crawlee passes error as 2nd argument)
            failedRequestHandler({ request, log: ctxLog, session }, error) {
                const logger = ctxLog || log;
                const message = error?.message || 'Unknown error';
                const status = error?.statusCode || error?.response?.statusCode;

                logger.error(`❌ Request failed${status ? ` (${status})` : ''}: ${request.url}`);
                logger.error(`Error: ${message}`);

                // Rotate session on hard blocks
                if (status === 403 && session?.retire) {
                    session.retire();
                }

                errors.push({
                    url: request.url,
                    error: message,
                    statusCode: status ?? null,
                    page: request.userData?.page || 'unknown',
                });
            },
        });

        // Start crawling
        log.info('🚀 Starting crawler...');
        await crawler.run(initial.map((u, idx) => ({ 
            url: u, 
            userData: { label: 'LIST', page: 1 },
            uniqueKey: `start-${idx}`,
        })));
        
        // ==========================================
        // FINAL SUMMARY
        // ==========================================
        log.info('='.repeat(60));
        log.info('📊 SCRAPING SUMMARY');
        log.info('='.repeat(60));
        log.info(`✅ Total products saved: ${saved}/${MAX_PRODUCTS}`);
        log.info(`📄 Total pages processed: ${pageCount}/${MAX_PAGES}`);
        log.info(`❌ Total errors: ${errors.length}`);
        
        if (errors.length > 0) {
            log.warning('⚠️ Errors encountered:');
            errors.slice(0, 5).forEach(err => {
                log.warning(`  - Page ${err.page}: ${err.error}`);
            });
            if (errors.length > 5) {
                log.warning(`  ... and ${errors.length - 5} more errors`);
            }
        }
        
        if (saved === 0) {
            log.error('🚨 NO PRODUCTS SAVED! Check errors above.');
        } else if (saved < MAX_PRODUCTS / 2) {
            log.warning(`⚠️ Only saved ${saved} products out of ${MAX_PRODUCTS} requested`);
        } else {
            log.info('✅ Scraping completed successfully!');
        }
        
        log.info('='.repeat(60));
        
    } catch (error) {
        log.exception(error, 'Fatal error in main function');
        throw error;
    } finally {
        await Actor.exit();
    }
}

main().catch(err => { 
    log.exception(err, 'Unhandled error in main');
    process.exit(1); 
});
