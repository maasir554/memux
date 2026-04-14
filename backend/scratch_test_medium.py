import requests

url = "https://medium.com/towards-artificial-intelligence/the-death-of-cnns-how-vision-transformers-rewrote-computer-vision-in-3-years-part-1-the-cnn-era-2f7c9dda5774"
USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

r = requests.get(url, headers={"User-Agent": USER_AGENT})
print(r.status_code)
