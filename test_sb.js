import { fetchIPv4 as fetch } from './fetchIPv4.js';
import crypto from 'crypto';
import dns from 'dns';
dns.setDefaultResultOrder('ipv4first');

// Copy nguyên cặp key của bạn vào đây
const PUBLIC_KEY = 'test_977ec1f6be07a66229b434a575890b06caf21b5d1c727a27e53a9ab35ad'; 
const PRIVATE_KEY = 'test_d32754f41533fe7e0d467675e8438e72321bcebbce1375f1f00c4f162fd';

function buildStoryblocksUrlV2(resource, params = {}) {
    const expires = Math.floor(Date.now() / 1000) + 3600;
    const hmacKey = PRIVATE_KEY + expires;
    const hmac = crypto.createHmac('sha256', hmacKey).update(resource).digest('hex');

    const queryParams = new URLSearchParams({
        ...params,
        APIKEY: PUBLIC_KEY,
        EXPIRES: expires,
        HMAC: hmac,
        project_id: 'cory_corner_auto',
        user_id: 'khaitm_dev'
    });
    return `https://api.storyblocks.com${resource}?${queryParams.toString()}`;
}

async function testVideoAPI() {
    console.log("=== BẮT ĐẦU TEST API STORYBLOCKS VIDEO ===");
    
    // Test thử với từ khóa "aquarium fish" - từ khóa chắc chắn phải có kết quả
    const url = buildStoryblocksUrlV2('/api/v2/videos/search', { keywords: 'aquarium fish', results_per_page: 2 });
    
    try {
        const res = await fetch(url);
        console.log("Mã trạng thái (Status):", res.status);
        
        const text = await res.text();
        console.log("\nKết quả thô từ Server (Giới hạn 500 ký tự):");
        console.log(text.substring(0, 500)); 
    } catch (e) {
        console.log("Lỗi mạng:", e);
    }
}

testVideoAPI();
