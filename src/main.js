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
            fetchDetails = true, // enable detail-page enrichment by default (limits below keep it light)
            detailSampleLimit = null, // if null/undefined we enrich as many as possible (bounded below)
            proxyConfiguration,
        } = input;

        const MAX_PRODUCTS = Number.isFinite(+maxProducts) ? Math.max(1, +maxProducts) : 100;
        const MAX_PAGES = Number.isFinite(+maxPages) ? Math.max(1, +maxPages) : 10;
        const DETAIL_LIMIT = Number.isFinite(+detailSampleLimit)
            ? Math.max(0, Math.min(+detailSampleLimit, MAX_PRODUCTS))
            : MAX_PRODUCTS;

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
        const pushBuffer = [];
        const BATCH_SIZE = 50;
        let flushPromise = Promise.resolve();

        const flushBuffer = (force = false) => {
            flushPromise = flushPromise.then(async () => {
                if (pushBuffer.length >= BATCH_SIZE || (force && pushBuffer.length > 0)) {
                    const batch = pushBuffer.splice(0, pushBuffer.length);
                    await Dataset.pushData(batch);
                }
            });
            return flushPromise;
        };

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
                            timeout: { request: 10000 },
                            retry: { limit: 1, methods: ['GET'] },
                            throwHttpErrors: false,
                            proxyUrl: proxyConf ? await proxyConf.newUrl() : undefined,
                        });

                        if (response.statusCode && response.statusCode >= 400) {
                            log.debug(`[API] Endpoint ${apiUrl} returned ${response.statusCode}`);
                            continue;
                        }

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

        function extractProductData($, productElement, baseUrl, productMap = {}) {
            try {
                const $product = $(productElement);

                // Product URL - use the main product link
                const productLink = $product.find('a[href*="/p/"]').first();
                const productUrl = productLink.attr('href');
                const fullUrl = productUrl ? toAbs(productUrl, baseUrl) : null;

                if (!fullUrl) return null;

                // Product SKU/ID from URL - improved regex
                const skuMatch = fullUrl ? fullUrl.match(/\/([A-Z0-9]+)(?:\/p\/|\?|$)/i) : null;
                const sku = skuMatch ? skuMatch[1] : null;

                // --- TRY JSON LOOKUP FIRST ---
                let jsonProduct = null;
                if (sku && productMap[sku]) {
                    jsonProduct = productMap[sku];
                }

                // Product Title - use data-qa selector (Noon uses plp-product-box-name)
                const title = cleanText(
                    jsonProduct?.name ||
                    jsonProduct?.title ||
                    $product.find('[data-qa="plp-product-box-name"]').text() ||
                    $product.find('h2').first().text() ||
                    $product.find('[class*="productTitle"]').text() ||
                    productLink.attr('title')
                );

                if (!title) return null;

                // Product Image - use data-qa selector
                const imageElement = $product.find('[data-qa^="productImagePLP"] img, img[src*="nooncdn"], img').first();
                const image = jsonProduct?.image_key ? `https://f.nooncdn.com/products/${jsonProduct.image_key}.jpg` : (
                    imageElement.attr('src') ||
                    imageElement.attr('data-src') ||
                    imageElement.attr('srcset')?.split(' ')[0] || null
                );

                // Price information - use data-qa selector
                const priceContainer = $product.find('[data-qa="plp-product-box-price"]');

                // Current price
                const currentPriceText = priceContainer.find('strong').first().text() ||
                    priceContainer.find('[class*="sellingPrice"], [class*="current"]').first().text() ||
                    priceContainer.text();

                // Original price
                const originalPriceText = priceContainer.find('[class*="oldPrice"], [class*="wasPrice"], [class*="was"], span[style*="line-through"]').first().text() ||
                    priceContainer.find('span').filter((_, el) => {
                        const text = $(el).text();
                        const price = cleanPrice(text);
                        return price && price > cleanPrice(currentPriceText);
                    }).first().text();

                const discountText = $product.find('[class*="discount"], [data-qa*="discount"], [class*="OFF"]').first().text();

                const currentPrice = jsonProduct?.uom_price || jsonProduct?.sale_price || cleanPrice(currentPriceText);
                const originalPrice = jsonProduct?.price || jsonProduct?.original_price || cleanPrice(originalPriceText);
                const discount = discountText ? cleanText(discountText) : null;

                // --- RATING & REVIEWS ---
                let rating = jsonProduct?.brand_rating?.value || jsonProduct?.rating || null;
                let reviewsCount = jsonProduct?.rating_count || jsonProduct?.reviews_count || null;

                // DOM Fallback for Rating
                if (!rating) {
                    const ratingText = $product.find('[class*="RatingPreviewStar"] [class*="textCtr"]').text() ||
                        $product.find('[class*="RatingPreviewStar"] span').first().text();
                    const ratingMatch = ratingText ? ratingText.match(/([1-5]\.?\d?)/) : null;
                    if (ratingMatch) {
                        rating = parseFloat(ratingMatch[1]);
                    } else {
                        // Regex search in full text
                        const productBoxText = $product.text();
                        const patterns = [/\b([1-5]\.\d{1,2})\b/, /([1-5])\s*(?:stars?|out of 5)/i];
                        for (const pattern of patterns) {
                            const match = productBoxText.match(pattern);
                            if (match) {
                                rating = parseFloat(match[1]);
                                break;
                            }
                        }
                    }
                }

                // DOM Fallback for Reviews
                if (!reviewsCount) {
                    // Try sibling of rating star container (common pattern on listing page)
                    const reviewsSpan = $product.find('[class*="RatingPreviewStar"] + div span').text();
                    if (reviewsSpan) {
                        const match = reviewsSpan.match(/(\d+(?:,\d+)*(?:\.\d+)?K?)/i);
                        if (match) {
                            const str = match[1];
                            reviewsCount = str.toUpperCase().includes('K') ?
                                Math.round(parseFloat(str.replace(/K/i, '')) * 1000) :
                                parseInt(str.replace(/,/g, ''));
                        }
                    }

                    if (!reviewsCount) {
                        // Full text regex fallback
                        const productBoxText = $product.text();
                        const patterns = [
                            /\((\d+(?:,\d+)*(?:\.\d+)?K?)\)/,
                            /(\d+(?:,\d+)*)\s*(?:ratings?|reviews?)/i
                        ];
                        for (const pattern of patterns) {
                            const match = productBoxText.match(pattern);
                            if (match) {
                                const str = match[1];
                                reviewsCount = str.toUpperCase().includes('K') ?
                                    Math.round(parseFloat(str.replace(/K/i, '')) * 1000) :
                                    parseInt(str.replace(/,/g, ''));
                                break;
                            }
                        }
                    }
                }

                // --- BRAND ---
                let brand = cleanText(
                    jsonProduct?.brand ||
                    jsonProduct?.brand_name ||
                    $product.find('[data-qa*="brand"], a[href*="/brand/"]').first().text()
                );

                // Listing page fallback: First word of title if not found (very common on Noon listing cards)
                if (!brand && title) {
                    const titleParts = title.split(' ');
                    if (titleParts.length > 0) {
                        // Simple heuristic: Take first word if capitalized
                        if (/^[A-Z0-9]/.test(titleParts[0])) {
                            brand = titleParts[0];
                        }
                    }
                }

                return {
                    title: title,
                    url: fullUrl,
                    image: image,
                    brand: brand || null,
                    description: null, // filled via detail page enrichment if available
                    currentPrice: currentPrice,
                    originalPrice: originalPrice,
                    discount: discount,
                    rating: rating,
                    reviewsCount: reviewsCount,
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
                    timeout: { request: 20000 },
                    retry: { limit: 1 },
                    proxyUrl: proxyConf ? await proxyConf.newUrl() : undefined,
                });

                const $ = loadHtml(resp.body);

                // Try structured data first (JSON-LD) - most reliable source
                let ldDescription = null;
                let ldBrand = null;
                let ldRating = null;
                let ldReviews = null;
                $('script[type="application/ld+json"]').each((_, el) => {
                    try {
                        const parsed = JSON.parse($(el).text().trim());
                        const nodes = Array.isArray(parsed) ? parsed : [parsed];
                        for (const node of nodes) {
                            if (!node || typeof node !== 'object') continue;
                            const isProduct = node['@type'] === 'Product' || (Array.isArray(node['@type']) && node['@type'].includes('Product'));
                            if (!isProduct) continue;

                            ldDescription = ldDescription || cleanText(node.description || node?.mainEntity?.description);
                            const brandVal = node.brand;
                            if (brandVal) {
                                if (typeof brandVal === 'string') ldBrand = ldBrand || cleanText(brandVal);
                                if (typeof brandVal === 'object') ldBrand = ldBrand || cleanText(brandVal.name);
                            }
                            const agg = node.aggregateRating || node?.mainEntity?.aggregateRating;
                            if (agg) {
                                ldRating = ldRating || parseFloat(agg.ratingValue || agg.rating);
                                ldReviews = ldReviews || parseInt(agg.reviewCount || agg.ratingCount);
                            }
                        }
                    } catch {
                        // ignore malformed JSON-LD
                    }
                });

                // Description - try multiple sources (user-provided selector first)
                const metaDescription = cleanText(
                    $('meta[name="description"]').attr('content') ||
                    $('meta[property="og:description"]').attr('content')
                );

                // Try to find data in script tags (Next.js data often in self.__next_f or similar)
                let scriptData = {
                    rating: null,
                    reviews: null,
                    description: null,
                    brand: null
                };

                $('script').each((_, el) => {
                    const text = $(el).html();
                    if (!text) return;

                    // Extract rating from JSON in scripts (e.g. "brand_rating":{"value":4.3})
                    if (!scriptData.rating) {
                        const rateMatch = text.match(/"brand_rating":\s*\{\s*"value":\s*([0-9.]+)/);
                        if (rateMatch) scriptData.rating = parseFloat(rateMatch[1]);
                    }

                    // Extract reviews count
                    if (!scriptData.reviews) {
                        const revMatch = text.match(/"rating_count":\s*([0-9]+)/) ||
                            text.match(/"review_count":\s*([0-9]+)/) ||
                            text.match(/"count":\s*([0-9]+),\s*"average"/); // common pattern
                        if (revMatch) scriptData.reviews = parseInt(revMatch[1]);
                    }

                    // Extract description - improved regex to handle escaped quotes
                    if (!scriptData.description) {
                        const descMatch = text.match(/"long_description":\s*"((?:[^"\\]|\\.)*)"/);
                        if (descMatch) scriptData.description = cleanText(descMatch[1].replace(/\\"/g, '"').replace(/\\n/g, '<br>'));
                    }

                    // Extract feature bullets (Highlights)
                    if (!scriptData.feature_bullets) {
                        const bullyMatch = text.match(/"feature_bullets":\s*(\[[^\]]+\])/);
                        if (bullyMatch) {
                            try {
                                // Try to parse the array (might need unescaping)
                                const rawArr = bullyMatch[1].replace(/\\"/g, '"');
                                const bullets = JSON.parse(rawArr);
                                if (Array.isArray(bullets) && bullets.length > 0) {
                                    scriptData.feature_bullets = '<ul>' + bullets.map(b => `<li>${b}</li>`).join('') + '</ul>';
                                }
                            } catch (e) {
                                // simple fallback if parse fails
                                scriptData.feature_bullets = null;
                            }
                        }
                    }

                    // Extract specifications for basic table
                    if (!scriptData.specifications) {
                        const specMatch = text.match(/"specifications":\s*(\[[^\]]+\])/);
                        if (specMatch) {
                            try {
                                const rawSpec = specMatch[1].replace(/\\"/g, '"');
                                const specs = JSON.parse(rawSpec);
                                if (Array.isArray(specs) && specs.length > 0) {
                                    const rows = specs.map(s => `<tr><td><strong>${s.name}</strong></td><td>${s.value}</td></tr>`).join('');
                                    scriptData.specifications = `<table class="spec-table">${rows}</table>`;
                                }
                            } catch (e) {
                                scriptData.specifications = null;
                            }
                        }
                    }

                    // Extract brand
                    if (!scriptData.brand) {
                        const brandMatch = text.match(/"brand":\s*\{\s*"code":\s*"[^"]+",\s*"name":\s*"([^"]+)"/);
                        if (brandMatch) scriptData.brand = cleanText(brandMatch[1]);
                    }
                });

                // Description container - fallback chain
                // Priority: Script Description > Script Highlights > Script Specs > DOM Selectors
                const description = cleanText(
                    scriptData.description ||
                    (scriptData.feature_bullets ? `<h3>Highlights</h3>${scriptData.feature_bullets}` : null) ||
                    (scriptData.specifications ? `<h3>Specifications</h3>${scriptData.specifications}` : null) ||
                    $('div.OverviewTab-module-scss-module__NTeOuq__container').text() ||
                    $('[class*="OverviewTab"][class*="container"]').text() ||
                    $('#OverviewArea').text() ||
                    $('[data-qa*="overview"]').text() ||
                    metaDescription ||
                    ldDescription
                ) || product.description;

                // Brand - use exact user-provided selector with textContent child
                const brand = cleanText(
                    scriptData.brand || // Script data priority
                    $('div.BrandStoreCtaV2-module-scss-module___vJ0Tq__brandAndVariantsButton [class*="textContent"]').text() ||
                    $('[class*="BrandStoreCtaV2"] [class*="textContent"]').first().text() ||
                    $('a.BrandStoreCtaV2-module-scss-module___vJ0Tq__brandStoreLink').first().text() ||
                    $('a[href*="/brand/"]').first().text() ||
                    $('[data-qa*="brand"]').first().text() ||
                    ldBrand
                ) || product.brand;

                // Rating - use exact user-provided selector with span child for text
                const ratingElement = $('div.RatingPreviewStarV2-module-scss-module__0_8vQW__starsCtr span.RatingPreviewStarV2-module-scss-module__0_8vQW__text');
                let rating = null;
                if (ratingElement.length) {
                    const ratingText = ratingElement.text();
                    const ratingMatch = ratingText.match(/([1-5]\.?\d?)/);
                    if (ratingMatch) rating = parseFloat(ratingMatch[1]);
                }
                if (!rating && scriptData.rating) rating = scriptData.rating; // Script data fallback
                if (!rating && ldRating) rating = ldRating;
                if (!rating) {
                    // Fallback to searching in page text
                    const pageText = $('body').text();
                    const fallbackMatch = pageText.match(/\b([1-5]\.\d{1,2})\s*(?:out of 5|\/5|\s*stars?)?/i);
                    if (fallbackMatch) rating = parseFloat(fallbackMatch[1]);
                }
                rating = rating || product.rating;

                // Reviews count - extract from "Based on X ratings" text
                let reviewsCount = null;
                const pageText = $('body').text();

                // Try to find "Based on X ratings" pattern first (most reliable DOM pattern)
                const basedOnMatch = pageText.match(/Based on ([\d,]+)\s*(?:ratings?|reviews?)/i);
                if (basedOnMatch) {
                    reviewsCount = parseInt(basedOnMatch[1].replace(/,/g, ''));
                } else if (scriptData.reviews) {
                    reviewsCount = scriptData.reviews; // Script data fallback
                } else {
                    // Fallback to other patterns
                    const reviewsElement = $('div.RatingPreviewStarV2-module-scss-module__0_8vQW__ratingsCountCtr');
                    if (reviewsElement.length) {
                        const reviewsText = reviewsElement.text();
                        // Skip if it's just "Brand Rating"
                        if (!reviewsText.includes('Brand Rating')) {
                            const reviewsMatch = reviewsText.match(/(\d+(?:,\d+)*(?:\.\d+)?K?)/i);
                            if (reviewsMatch) {
                                const reviewStr = reviewsMatch[1];
                                if (reviewStr.toUpperCase().includes('K')) {
                                    reviewsCount = Math.round(parseFloat(reviewStr.replace(/K/i, '')) * 1000);
                                } else {
                                    reviewsCount = parseInt(reviewStr.replace(/,/g, ''));
                                }
                            }
                        }
                    }
                }
                if (!reviewsCount && ldReviews) reviewsCount = ldReviews;
                if (!reviewsCount) {
                    // Final fallback to regex on page text
                    const patterns = [
                        /(\d+(?:,\d+)*)\s*(?:ratings?|reviews?)/i,
                        /\((\d+(?:,\d+)*)\)/
                    ];
                    for (const pattern of patterns) {
                        const match = pageText.match(pattern);
                        if (match) {
                            reviewsCount = parseInt(match[1].replace(/,/g, ''));
                            break;
                        }
                    }
                }
                reviewsCount = reviewsCount || product.reviewsCount;

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
                        // Note: Pagination will be queued AFTER saving products
                    }
                    // ========================================
                    // STEP 2: Fallback to HTML parsing
                    // ========================================
                    // ========================================
                    // STEP 2: Fallback to HTML parsing
                    // ========================================
                    else {
                        crawlerLog.warning('⚠️ [API] Failed, falling back to HTML parsing');

                        // --- NEW: Parse Next.js Data for Fallback ---
                        let productMap = {};
                        try {
                            const nextDataScript = $('#__NEXT_DATA__').html();
                            if (nextDataScript) {
                                const nextData = JSON.parse(nextDataScript);

                                // Helper to recursively find "hits" or products array
                                const findHits = (obj, depth = 0) => {
                                    if (!obj || depth > 5) return [];
                                    if (Array.isArray(obj)) return obj; // If it's already an array, check it
                                    if (obj.hits && Array.isArray(obj.hits)) return obj.hits;
                                    if (obj.products && Array.isArray(obj.products)) return obj.products;

                                    // Should be in props.pageProps.catalog.hits usually
                                    for (const key in obj) {
                                        if (typeof obj[key] === 'object') {
                                            const found = findHits(obj[key], depth + 1);
                                            if (found && found.length > 0) return found;
                                        }
                                    }
                                    return [];
                                };

                                // Try standard path first for speed
                                let hits = nextData?.props?.pageProps?.catalog?.hits ||
                                    nextData?.props?.pageProps?.initialData?.catalog?.hits;

                                // If not found, search
                                if (!hits || hits.length === 0) {
                                    hits = findHits(nextData?.props?.pageProps);
                                }

                                if (hits && Array.isArray(hits)) {
                                    crawlerLog.info(`🔍 [HTML] Found ${hits.length} products in hidden JSON data`);
                                    hits.forEach(hit => {
                                        if (hit.sku || hit.product_code) {
                                            productMap[hit.sku || hit.product_code] = hit;
                                        }
                                    });
                                }
                            }
                        } catch (e) {
                            crawlerLog.debug(`[HTML] Failed to parse JSON data: ${e.message}`);
                        }

                        // Try multiple selectors for product containers
                        const productSelectors = [
                            '[data-qa="plp-product-box"]',  // Primary: Noon's main product box container
                            '[data-qa*="product-box"]',      // Fallback: any product box variant
                            '[data-qa*="product"]',          // Fallback: any product element
                            '[class*="ProductCard"]',
                            '[class*="productContainer"]',
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

                            // Pass productMap to extraction function
                            const productData = extractProductData($, productEl, request.url, productMap);
                            if (productData && validateProduct(productData)) {
                                productsToSave.push(productData);
                            }
                        });
                        // Note: Pagination will be queued AFTER saving products
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
                            const needsDetail = !prod.description || !prod.brand || !prod.rating || !prod.reviewsCount;
                            if (fetchDetails && detailFetched < DETAIL_LIMIT && needsDetail) {
                                const enriched = await enrichProductWithDetails(prod);
                                enrichedProducts.push(enriched);
                                detailFetched += 1;
                            } else {
                                enrichedProducts.push(prod);
                            }
                        }

                        if (enrichedProducts.length > 0) {
                            pushBuffer.push(...enrichedProducts);
                            await flushBuffer();
                            saved += enrichedProducts.length;
                            crawlerLog.info(`💾 Saved ${enrichedProducts.length} products (Total: ${saved}/${MAX_PRODUCTS})`);

                            // Log sample product for verification
                            crawlerLog.debug(`Sample product: ${JSON.stringify(enrichedProducts[0], null, 2)}`);
                        }
                    } else {
                        crawlerLog.warning('⚠️ No valid products to save from this page');
                    }

                    // ========================================
                    // STEP 4: Queue next page ONLY if needed
                    // ========================================
                    if (saved < MAX_PRODUCTS && pageCount < MAX_PAGES) {
                        if (apiResult.success && apiResult.pagination?.hasNext) {
                            // API pagination
                            const nextPageNum = currentPage + 1;
                            const nextUrl = new URL(request.url);
                            nextUrl.searchParams.set('page', String(nextPageNum));

                            await crawler.addRequests([{
                                url: nextUrl.href,
                                userData: { label: 'LIST', page: nextPageNum },
                            }]);

                            crawlerLog.info(`➡️ [API] Queued next page: ${nextPageNum}`);
                        } else if (productsToSave.length > 0) {
                            // HTML pagination
                            const isProductLink = (href) => href && /\/p\//i.test(href);
                            const nextPageLink = $('a[aria-label*="next"]').first().attr('href') ||
                                $('a[class*="next"]').first().attr('href') ||
                                $(`a:contains("${currentPage + 1}")`).first().attr('href');

                            if (nextPageLink && !isProductLink(nextPageLink)) {
                                const nextUrl = toAbs(nextPageLink, request.url);
                                await crawler.addRequests([{
                                    url: nextUrl,
                                    userData: { label: 'LIST', page: currentPage + 1 },
                                }]);
                                crawlerLog.info(`➡️ [HTML] Queued next page: ${nextUrl}`);
                            } else {
                                // Try constructing next page URL
                                const nextUrl = new URL(request.url);
                                if (isProductLink(nextUrl.pathname)) {
                                    const parts = nextUrl.pathname.split('/').filter(Boolean);
                                    const pIndex = parts.findIndex((p) => p.toLowerCase() === 'p');
                                    const listParts = pIndex > 0 ? parts.slice(0, pIndex) : parts;
                                    nextUrl.pathname = `/${listParts.join('/')}/`;
                                }
                                nextUrl.searchParams.set('page', String(currentPage + 1));
                                if (!nextUrl.searchParams.has('limit')) {
                                    nextUrl.searchParams.set('limit', '50');
                                }

                                await crawler.addRequests([{
                                    url: nextUrl.href,
                                    userData: { label: 'LIST', page: currentPage + 1 },
                                }]);

                                crawlerLog.info(`➡️ [HTML] Constructed next page URL: ${nextUrl.href}`);
                            }
                        }
                    } else {
                        crawlerLog.info(`🛑 Stopping pagination: saved=${saved}/${MAX_PRODUCTS}, pages=${pageCount}/${MAX_PAGES}`);
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
        await flushBuffer(true);

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
