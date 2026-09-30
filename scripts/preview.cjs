const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { tweet, timeline } = require("../tests/fixtures.cjs");
const root = path.resolve(__dirname, "..");
const port = Number(process.env.DOWNSTREAM_PREVIEW_PORT) || 4173;
let sequence = 0;
const texts = [
  "好的工具不需要你记住操作步骤。\n\n它应该顺着你的习惯，让下一步自然发生。",
  "今天的一个小发现：把「获取内容」和「阅读内容」分开，很多界面上的来回跳转就消失了。",
  "与其追求更多功能，不如把一个每天重复的动作，做到足够顺手。",
  "从第一性原理看阅读体验：\n\n1. 读过的内容不应该反复出现。\n2. 更新不应该改变正在看的位置。\n3. 下一个动作应该和上一个动作一致。\n\n于是，新内容接在下方。",
  "「再来一批」应该是数据的动作，而不是让人挪动位置的理由。",
  "先让一条阅读路径成立，再考虑更多设置。今天就从「一直向下」开始。"
];
const initial = texts.map((text, i) => {
  const post = tweet(1000 + i, text);
  delete post.core.user_results.result.avatar;
  const names = [["林间", "forest_notes"], ["许一", "one_small_step"], ["产品手记", "product_journal"]];
  post.core.user_results.result.core = { name: names[i % 3][0], screen_name: names[i % 3][1] };
  post.legacy.created_at = new Date(Date.UTC(2026, 8, 30, 3, 0) - i * 600000).toUTCString();
  return post;
});
initial[2].quoted_status_result = { result: tweet(900, "设计最好的时刻，是你不再需要解释怎么用了。") };
delete initial[2].quoted_status_result.result.core.user_results.result.avatar;
const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${port}`);
  if (/^\/i\/api\/graphql\/native-action\/(FavoriteTweet|CreateBookmark|CreateRetweet)$/.test(url.pathname)) {
    response.writeHead(200, { "content-type": "application/json" });
    return response.end(JSON.stringify({ data: { ok: true, demoOnly: true } }));
  }
  if (/^\/i\/api\/graphql\/local-demo\/Home(Latest)?Timeline$/.test(url.pathname)) {
    const first = String(request.headers["x-client-transaction-id"] || "").endsWith("-1");
    const posts = first ? initial : [initial[0], ...Array.from({ length: 3 }, (_, i) => {
      const post = tweet(3000 + ++sequence, `这是刚接上的第 ${sequence} 条新内容。\n\n${texts[(sequence + i) % texts.length]}\n\n你的位置没有变化，继续向下就好。`);
      delete post.core.user_results.result.avatar;
      post.legacy.created_at = new Date().toUTCString();
      return post;
    })];
    response.writeHead(200, { "content-type": "application/json" });
    return response.end(JSON.stringify(timeline(posts, "demo-backlog")));
  }
  const route = url.pathname === "/" || url.pathname === "/home" ? "/demo/index.html" : url.pathname;
  const file = path.resolve(root, "." + route);
  if (!file.startsWith(root + path.sep) || !["/demo/", "/extension/"].some(prefix => route.startsWith(prefix)) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    response.writeHead(404); return response.end("Not found");
  }
  const types = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png" };
  response.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
  fs.createReadStream(file).pipe(response);
});
server.listen(port, "127.0.0.1", () => console.log(`Downstream offline demo: http://127.0.0.1:${port}/home`));
server.on("error", error => { console.error(error.message); process.exitCode = 1; });
