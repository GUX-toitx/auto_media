import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ProxyAgent } from 'undici';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');   // src/lib -> gốc repo
const PROXY_FILE = path.join(ROOT, 'config', 'proxies.txt');

// Bật proxy bằng env: USE_PROXY=1 (mặc định tắt -> đi thẳng, vì proxy có thể chỉ whitelist cho server prod)
export const PROXY_ENABLED = process.env.USE_PROXY === '1' || process.env.USE_PROXY === 'true';

let proxies = null;
function load() {
    if (proxies) return proxies;
    proxies = [];
    try {
        for (const line of fs.readFileSync(PROXY_FILE, 'utf-8').split('\n')) {
            const t = line.trim();
            if (!t) continue;
            const [host, port, user, pass] = t.split(':');
            if (host && port) proxies.push({ host, port, user, pass });
        }
    } catch (_) {}
    return proxies;
}

export function hasProxies() { return load().length > 0; }

// Trả về { server, uri, dispatcher } ngẫu nhiên, hoặc null nếu tắt/không có proxy
export function getRandomProxy() {
    if (!PROXY_ENABLED) return null;
    const list = load();
    if (!list.length) return null;
    const p = list[Math.floor(Math.random() * list.length)];
    const auth = (p.user && p.pass) ? `${encodeURIComponent(p.user)}:${encodeURIComponent(p.pass)}@` : '';
    const uri = `http://${auth}${p.host}:${p.port}`;
    return {
        server: `${p.host}:${p.port}`,
        uri,
        dispatcher: new ProxyAgent({ uri, connect: { family: 4, timeout: 12000 } }),
    };
}
