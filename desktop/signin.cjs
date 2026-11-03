// Signing in from the desktop app. Google (and Steam on the web) refuse sign-ins inside an app's
// own window, so the player signs in in their normal browser, as RFC 8252 asks of native apps: the
// game server's sign-in sends that browser back to a page this app serves on 127.0.0.1, and the
// page hands the app the session token. The random path stops other pages on this computer from
// handing it one of theirs.

const crypto = require('node:crypto');
const http = require('node:http');

/** A sign-in started and never finished is given up after this long, ms */
const TIMEOUT_MS = 10 * 60_000;

/** The page the browser comes back to: the token is in its address after #, which only the page sees. */
const page = nonce => `<!doctype html><html><head><meta charset="utf-8"><title>UrSim</title>
<style>body{font:18px system-ui,sans-serif;background:#0f1216;color:#eef2f6;display:grid;place-items:center;min-height:90vh;margin:0}main{max-width:420px;text-align:center}</style></head>
<body><main id="m">…</main><script>
var hash=location.hash.slice(1);history.replaceState(null,'',location.pathname);
var ok=/(^|&)ursim_token=/.test(hash);
fetch('/token/${nonce}',{method:'POST',body:hash}).catch(function(){}).then(function(){
document.getElementById('m').textContent=ok?'UrSim: signed in. Close this tab and go back to the game. · Вход выполнен: вернись в игру.':'UrSim: sign-in failed. Try again from the game. · Не получилось войти: попробуй ещё раз из игры.'});
</script></body></html>`;

/**
 * Signs in with `provider` on the game server at `server` in the browser `open` shows. Resolves
 * with the session token, or null when the sign-in failed or was given up.
 */
function signInThroughBrowser(server, provider, open, timeout = TIMEOUT_MS) {
  return new Promise(resolve => {
    const nonce = crypto.randomBytes(16).toString('hex');
    let finished = false;
    const finish = token => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      local.close();
      resolve(token || null);
    };
    const local = http.createServer((req, res) => {
      const path = new URL(req.url, 'http://127.0.0.1').pathname;
      if (req.method === 'GET' && path === `/done/${nonce}`) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
        res.end(page(nonce));
        return;
      }
      if (req.method === 'POST' && path === `/token/${nonce}`) {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', chunk => {
          body += chunk;
          if (body.length > 4096) req.destroy();
        });
        req.on('end', () => {
          res.writeHead(204);
          res.end();
          finish(new URLSearchParams(body).get('ursim_token'));
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const timer = setTimeout(() => finish(null), timeout);
    local.on('error', () => finish(null));
    local.listen(0, '127.0.0.1', () => {
      const origin = `http://127.0.0.1:${local.address().port}`;
      const start = new URL(`/auth/${provider}/start`, server);
      start.searchParams.set('origin', origin);
      start.searchParams.set('return', `${origin}/done/${nonce}`);
      start.searchParams.set('mode', 'redirect');
      Promise.resolve(open(start.toString())).catch(() => finish(null));
    });
  });
}

module.exports = { signInThroughBrowser };
