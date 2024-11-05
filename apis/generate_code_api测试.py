import http.client
import json

conn = http.client.HTTPConnection("127.0.0.1", 8000)
payload = json.dumps({
   "question": "生成一个贪吃蛇项目",
   "language": "python"
})
headers = {
   'User-Agent': 'Apifox/1.0.0 (https://apifox.com)',
   'Content-Type': 'application/json'
}
conn.request("POST", "/generate", payload, headers)
res = conn.getresponse()
data = res.read()
print(data.decode("utf-8"))