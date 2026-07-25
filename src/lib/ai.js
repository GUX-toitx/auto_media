// ============================================================================
// LỚP TRỪU TƯỢNG NHÀ CUNG CẤP AI — chọn bằng .env: AI_PROVIDER=openai|deepseek
//
//   AI_PROVIDER=openai    -> dùng OpenAI như cũ (gpt-5 Responses API + web search)
//   AI_PROVIDER=deepseek  -> dùng DeepSeek (rẻ hơn nhiều), API kiểu OpenAI-compatible
//
// Khác biệt đã xử lý sẵn bên trong:
//   1. DeepSeek KHÔNG có /v1/responses  -> quy về /chat/completions
//   2. DeepSeek KHÔNG có json_schema strict -> dùng json_object + nhét schema vào prompt
//   3. DeepSeek KHÔNG có web_search_preview -> bỏ tool đó (log cảnh báo)
//   4. Bật suy luận bằng thinking:{type:'enabled'} + reasoning_effort thay cho reasoning.effort
// ============================================================================
import https from 'https';

const PROVIDER = (process.env.AI_PROVIDER || 'openai').trim().toLowerCase();
const OPENAI_KEY = process.env.OPENAI_KEY || process.env.OPENAI_API_KEY || '';
const DEEPSEEK_KEY = process.env.DEEPSEEK_KEY || process.env.DEEPSEEK_API_KEY || '';

export const isDeepSeek = () => PROVIDER === 'deepseek';
export const aiProviderName = () => (isDeepSeek() ? 'deepseek' : 'openai');

// Tầng model: 'main' = mạnh nhất (sinh kịch bản), 'std' = tầm trung, 'mini' = rẻ (keyword/chấm điểm/dịch)
const MODELS = {
    openai: { main: 'gpt-5', std: 'gpt-4o', mini: 'gpt-4o-mini' },
    deepseek: {
        main: process.env.DEEPSEEK_MODEL_MAIN || 'deepseek-v4-pro',
        std:  process.env.DEEPSEEK_MODEL_STD  || 'deepseek-v4-flash',
        mini: process.env.DEEPSEEK_MODEL_MINI || 'deepseek-v4-flash',
    },
};
export const modelFor = (tier) => MODELS[aiProviderName()][tier] || tier;

const apiBase = () => (isDeepSeek() ? 'https://api.deepseek.com' : 'https://api.openai.com');
const apiKey  = () => (isDeepSeek() ? DEEPSEEK_KEY : OPENAI_KEY);

export function assertAiKey() {
    if (!apiKey()) throw new Error(`Thiếu API key cho AI_PROVIDER=${aiProviderName()} — đặt ${isDeepSeek() ? 'DEEPSEEK_KEY' : 'OPENAI_KEY'} trong .env`);
}

// Lone surrogate (nửa cặp UTF-16) do nội dung cào web/tweet có emoji, hoặc do .slice() cắt trúng
// giữa cặp emoji. JSON.stringify vẫn xuất ra dạng \uD83D đơn lẻ → parser strict của OpenAI từ chối
// với lỗi 400 "failed to parse JSON value" → mất cả kịch bản. Loại bỏ, GIỮ NGUYÊN cặp emoji hợp lệ.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

// POST JSON thuần (giữ nguyên hành vi httpsPost cũ: trả { status, body })
export function httpsPostJson(url, headers, body) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const data = JSON.stringify(body, (_k, v) => typeof v === 'string' ? v.replace(LONE_SURROGATE, '') : v);
        const req = https.request({
            hostname: urlObj.hostname,
            path: urlObj.pathname + (urlObj.search || ''),
            method: 'POST',
            family: 4,
            headers: { ...headers, 'Content-Length': Buffer.byteLength(data) },
        }, (res) => {
            let raw = '';
            res.on('data', c => raw += c);
            res.on('end', () => resolve({ status: res.statusCode, body: raw }));
        });
        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

const authHeaders = () => ({ 'Authorization': `Bearer ${apiKey()}`, 'Content-Type': 'application/json' });

// ---------------------------------------------------------------------------
// aiChat — gọi chat/completions, dùng chung cho cả 2 provider.
//   tier: 'main' | 'std' | 'mini'   (hoặc truyền model cụ thể qua `model`)
//   json: true  -> ép trả JSON (response_format json_object)
// Trả { content, usage, status, raw }
// ---------------------------------------------------------------------------
export async function aiChat({ tier = 'mini', model, messages, temperature, json = false, maxTokens, effort } = {}) {
    assertAiKey();
    const body = { model: model || modelFor(tier), messages };
    if (temperature !== undefined) body.temperature = temperature;
    if (json) body.response_format = { type: 'json_object' };
    if (maxTokens) body.max_tokens = maxTokens;
    // DeepSeek: bật suy luận cho tầng 'main'
    if (isDeepSeek() && (effort || tier === 'main')) {
        body.thinking = { type: 'enabled' };
        body.reasoning_effort = effort || 'medium';
    }
    const res = await httpsPostJson(`${apiBase()}/${isDeepSeek() ? '' : 'v1/'}chat/completions`, authHeaders(), body);
    if (res.status !== 200) throw new Error(`[AI:${aiProviderName()}] lỗi ${res.status}: ${String(res.body).slice(0, 300)}`);
    const data = JSON.parse(res.body);
    return { content: data.choices?.[0]?.message?.content || '', usage: data.usage, status: res.status, raw: data };
}

// Mô tả schema thành chỉ dẫn prompt cho provider không có json_schema strict (DeepSeek).
// Bắt buộc có chữ "json" trong prompt (yêu cầu của DeepSeek JSON mode).
function schemaInstruction(schema, schemaName) {
    return [
        `Bạn PHẢI trả về DUY NHẤT một object json hợp lệ, không kèm giải thích, không bọc markdown.`,
        `Object json phải khớp CHÍNH XÁC json schema sau (tên: ${schemaName || 'result'}):`,
        JSON.stringify(schema),
        `Tuân thủ tuyệt đối: đúng tên trường, đúng kiểu, có ĐỦ mọi trường bắt buộc, KHÔNG thêm trường lạ.`,
    ].join('\n');
}

// ---------------------------------------------------------------------------
// aiStructured — sinh nội dung có SCHEMA (thay cho OpenAI /v1/responses + json_schema strict).
//   OpenAI  : giữ nguyên Responses API (có web_search_preview nếu bật)
//   DeepSeek: chat/completions + json_object + schema nhét vào system prompt (bỏ web search)
// Trả { outputText, usage }
// ---------------------------------------------------------------------------
export async function aiStructured({ schema, schemaName = 'result', input, effort = 'medium', maxTokens = 32000, webSearch = false, tier = 'main' } = {}) {
    assertAiKey();

    if (!isDeepSeek()) {
        const body = {
            model: modelFor(tier),
            reasoning: { effort },
            max_output_tokens: maxTokens,
            text: { format: { type: 'json_schema', name: schemaName, schema, strict: true } },
            input,
        };
        if (webSearch) body.tools = [{ type: 'web_search_preview' }];
        const res = await httpsPostJson('https://api.openai.com/v1/responses', authHeaders(), body);
        if (res.status !== 200) throw new Error(`[AI:openai] Responses lỗi ${res.status}: ${String(res.body).slice(0, 300)}`);
        const data = JSON.parse(res.body);
        if (data.status === 'incomplete') throw new Error(`[AI:openai] output bị cắt: ${data.incomplete_details?.reason} (${data.usage?.output_tokens}/${maxTokens})`);
        const outputText = data.output?.find(o => o.type === 'message')?.content?.find(c => c.type === 'output_text')?.text;
        if (!outputText) throw new Error('[AI:openai] không lấy được output: ' + JSON.stringify(data).slice(0, 200));
        return { outputText, usage: data.usage };
    }

    // --- DeepSeek ---
    if (webSearch) console.warn('[AI:deepseek] ⚠️  DeepSeek không có web_search — bỏ qua tool này (chỉ dùng dữ liệu trong prompt).');
    const { content, usage } = await aiChat({
        tier, json: true, maxTokens, effort,
        messages: [
            { role: 'system', content: schemaInstruction(schema, schemaName) },
            { role: 'user', content: String(input) },
        ],
    });
    let outputText = String(content || '').trim().replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
    if (!outputText) throw new Error('[AI:deepseek] không lấy được output');
    return { outputText, usage };
}

// Cấu hình cho SDK `openai` chính thức (DeepSeek tương thích OpenAI, chỉ khác baseURL).
//   const client = new OpenAI(openaiSdkConfig());
export function openaiSdkConfig() {
    return isDeepSeek()
        ? { apiKey: DEEPSEEK_KEY, baseURL: 'https://api.deepseek.com' }
        : { apiKey: OPENAI_KEY };
}

// Log gọn thông tin token sau mỗi lần gọi (2 provider tên trường khác nhau)
export function logUsage(tag, usage) {
    if (!usage) return;
    const inTok  = usage.input_tokens  ?? usage.prompt_tokens;
    const outTok = usage.output_tokens ?? usage.completion_tokens;
    const reason = usage.output_tokens_details?.reasoning_tokens ?? usage.completion_tokens_details?.reasoning_tokens;
    console.log(`[${tag}] ${aiProviderName()} tokens - input: ${inTok}, output: ${outTok}${reason ? `, reasoning: ${reason}` : ''}`);
}
