// Wrapper fetch force IPv4 để tránh ETIMEDOUT trên server không có IPv6
import { fetch as undiciFetch, Agent } from 'undici';

const ipv4Agent = new Agent({ connect: { family: 4 } });

export async function fetchIPv4(url, options = {}) {
    // Luôn gắn dispatcher, kể cả khi options có dispatcher riêng
    const { dispatcher, ...rest } = options;
    return undiciFetch(url, { ...rest, dispatcher: ipv4Agent });
}
