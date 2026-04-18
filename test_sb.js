import crypto from 'crypto';

// Copy nguyên cặp key của bạn vào đây
const PUBLIC_KEY = 'test_9cb0c8fde8b26045c96741419208b3375aaa29be8a7cb53bdcdd014c9cf'; 
const PRIVATE_KEY = 'test_642f2b19c5e574d3f189f28b78a1d1c802f0802ab385be61ed6c6a5bafc';

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
        console.log("Lỗi mạng:", e.message);
    }
}

testVideoAPI();
