# Noon.com Product Scraper

Fast and reliable scraper for extracting product data from Noon.com UAE marketplace. Extract product details including titles, prices, ratings, images, brand information, and more from any category or listing page.

## Features

- **Fast & Efficient** - Optimized for high-speed data extraction
- **Comprehensive Data** - Extracts all key product information including prices, ratings, reviews, and images
- **Smart Pagination** - Automatically follows pagination to scrape multiple pages
- **Flexible Configuration** - Control the number of products and pages to scrape
- **Anti-Bot Protection** - Built-in proxy support and smart request handling
- **Clean Output** - Structured JSON dataset ready for analysis

## What Data Can You Extract?

This scraper extracts the following information for each product:

- **Product Title** - Full product name and description
- **Brand** - Product manufacturer or brand name
- **Current Price** - Active selling price in AED
- **Original Price** - Original price before discount (if applicable)
- **Discount** - Discount percentage or amount
- **Rating** - Average customer rating (1-5 stars)
- **Reviews Count** - Number of customer reviews
- **Product Image** - High-quality product image URL
- **Product URL** - Direct link to the product page
- **SKU** - Unique product identifier
- **Currency** - Price currency (AED)
- **Scraped Timestamp** - Date and time when data was extracted

## How to Use

### Quick Start

1. **Open the Actor in Apify Console**
2. **Provide Input Parameters:**
   - Paste a Noon.com category or product listing URL
   - Set the maximum number of products to scrape
   - Configure proxy settings (recommended)
3. **Run the Actor**
4. **Download Results** in JSON, CSV, Excel, or HTML format

### Input Configuration

```json
{
  "startUrl": "https://www.noon.com/uae-en/fashion/men-31225/crazy-price-drops-ae-FA_03/",
  "maxProducts": 100,
  "maxPages": 10,
  "proxyConfiguration": {
    "useApifyProxy": true,
    "apifyProxyGroups": ["RESIDENTIAL"]
  }
}
```

### Input Parameters

#### `startUrl` (String, Optional)
Single Noon.com listing or category page URL to start scraping.

**Example:**
```
https://www.noon.com/uae-en/fashion/men-31225/
```

#### `startUrls` (Array, Optional)
Multiple Noon.com URLs to scrape in a single run.

**Example:**
```json
[
  { "url": "https://www.noon.com/uae-en/electronics/" },
  { "url": "https://www.noon.com/uae-en/beauty/" }
]
```

#### `maxProducts` (Integer, Default: 100)
Maximum number of products to scrape. Set to `0` for unlimited.

#### `maxPages` (Integer, Default: 10)
Maximum number of listing pages to crawl.

#### `proxyConfiguration` (Object, Recommended)
Proxy settings for the scraper. **Residential proxies are strongly recommended** for best results and to avoid blocks.

**Example:**
```json
{
  "useApifyProxy": true,
  "apifyProxyGroups": ["RESIDENTIAL"]
}
```

## Output Format

### Sample Output

```json
{
  "title": "Nike Men's Running Shoes",
  "brand": "Nike",
  "currentPrice": 299,
  "originalPrice": 449,
  "discount": "33% OFF",
  "rating": 4.5,
  "reviewsCount": 128,
  "image": "https://f.nooncdn.com/products/...",
  "url": "https://www.noon.com/uae-en/...",
  "sku": "N12345678",
  "currency": "AED",
  "scrapedAt": "2025-12-26T10:30:00.000Z"
}
```

### Output Fields

<table>
  <thead>
    <tr>
      <th>Field</th>
      <th>Type</th>
      <th>Description</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td><code>title</code></td>
      <td>String</td>
      <td>Product name and description</td>
    </tr>
    <tr>
      <td><code>brand</code></td>
      <td>String</td>
      <td>Brand or manufacturer name</td>
    </tr>
    <tr>
      <td><code>currentPrice</code></td>
      <td>Number</td>
      <td>Current selling price in AED</td>
    </tr>
    <tr>
      <td><code>originalPrice</code></td>
      <td>Number</td>
      <td>Original price before discount</td>
    </tr>
    <tr>
      <td><code>discount</code></td>
      <td>String</td>
      <td>Discount amount or percentage</td>
    </tr>
    <tr>
      <td><code>rating</code></td>
      <td>Number</td>
      <td>Average customer rating (1-5)</td>
    </tr>
    <tr>
      <td><code>reviewsCount</code></td>
      <td>Number</td>
      <td>Total number of reviews</td>
    </tr>
    <tr>
      <td><code>image</code></td>
      <td>String</td>
      <td>Product image URL</td>
    </tr>
    <tr>
      <td><code>url</code></td>
      <td>String</td>
      <td>Direct product page URL</td>
    </tr>
    <tr>
      <td><code>sku</code></td>
      <td>String</td>
      <td>Unique product identifier</td>
    </tr>
    <tr>
      <td><code>currency</code></td>
      <td>String</td>
      <td>Price currency (AED)</td>
    </tr>
    <tr>
      <td><code>scrapedAt</code></td>
      <td>String</td>
      <td>ISO 8601 timestamp of extraction</td>
    </tr>
  </tbody>
</table>

## Use Cases

### E-commerce Intelligence
- **Price Monitoring** - Track product prices over time
- **Competitor Analysis** - Monitor competitor pricing and product offerings
- **Market Research** - Analyze product categories and trends

### Data Analysis
- **Price Comparison** - Compare prices across different products
- **Rating Analysis** - Identify top-rated products in each category
- **Discount Tracking** - Find best deals and discount patterns

### Business Applications
- **Inventory Planning** - Research popular products and trends
- **Dynamic Pricing** - Adjust your pricing based on market data
- **Product Research** - Discover new products and categories

## Tips for Best Results

### 1. Use Residential Proxies
For reliable and consistent scraping, always use residential proxies. This prevents IP blocks and ensures smooth data extraction.

### 2. Start with Smaller Batches
Test with `maxProducts: 50` and `maxPages: 5` first, then scale up based on your needs.

### 3. Choose Specific Categories
Instead of scraping entire site, target specific category URLs for faster and more relevant results.

### 4. Schedule Regular Runs
Use Apify's scheduling feature to run the scraper regularly for price monitoring and trend analysis.

### 5. Monitor Your Runs
Check Actor logs to ensure scraping is working correctly and adjust parameters if needed.

## Technical Details

### Performance
- **Speed:** ~100-200 products per minute (with residential proxies)
- **Concurrency:** Optimized for 5 concurrent requests
- **Retry Logic:** Automatic retry on failed requests (3 attempts)

### Requirements
- **Apify Proxy** (residential recommended) or custom proxy
- **Compute Units:** ~0.01 CU per 50 products

### Technology Stack
- Built with **Crawlee** framework
- Uses **CheerioCrawler** for fast HTML parsing
- **Node.js 22** runtime

## Limitations

- Only supports Noon.com UAE marketplace (`noon.com/uae-en`)
- Requires active internet connection and proxy access
- Subject to Noon.com's website structure changes

## Troubleshooting

### No Products Found
- Verify the URL is a valid Noon.com listing or category page
- Check that the page contains products
- Ensure residential proxies are configured

### Scraper Running Slowly
- Reduce `maxConcurrency` if using free proxies
- Use residential proxies for faster speeds
- Check your proxy performance in Apify Console

### Missing Data Fields
- Some products may not have all fields (e.g., no discount, no reviews)
- The scraper returns `null` for missing fields

## Support & Feedback

Need help or have suggestions? Contact us:

- **Issues:** Open an issue on GitHub
- **Questions:** Ask in Apify Community Discord
- **Custom Development:** Contact for enterprise solutions

## Legal & Compliance

This Actor extracts publicly available data from Noon.com. Users are responsible for:
- Complying with Noon.com's Terms of Service
- Following applicable data protection laws
- Using extracted data ethically and legally

Always respect website robots.txt and rate limits.

## Version History

### 1.0.0 (2025-12-26)
- Initial release
- Support for product listing pages
- Pagination support
- Comprehensive product data extraction
- Proxy configuration support

---

**Made with ❤️ by Shahid Irfan**

**Keywords:** noon.com scraper, uae product scraper, e-commerce data extraction, price monitoring, noon scraping tool, product data api, noon.com api alternative
