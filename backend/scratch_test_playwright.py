import sys

try:
    from playwright.sync_api import sync_playwright
except Exception as e:
    print(f"Import failed: {e}")
    sys.exit(1)

url = "https://medium.com/towards-artificial-intelligence/the-death-of-cnns-how-vision-transformers-rewrote-computer-vision-in-3-years-part-1-the-cnn-era-2f7c9dda5774"

try:
    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=["--disable-dev-shm-usage", "--no-sandbox"],
        )
        context = browser.new_context(
            viewport={"width": 1366, "height": 900},
            user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        )
        page = context.new_page()
        print("Going to URL...")
        response = page.goto(url, wait_until="domcontentloaded", timeout=30000)
        print("Status code:", response.status if response else "No response")
        page.wait_for_timeout(1000)
        html = page.content()
        final_url = page.url
        print(f"Final URL: {final_url}")
        print(f"HTML len: {len(html)}")
        context.close()
        browser.close()
except Exception as e:
    import traceback
    print(f"Playwright error: {e}")
    traceback.print_exc()

