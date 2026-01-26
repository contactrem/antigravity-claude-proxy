/**
 * Test Endpoint Failover
 * Verifies that 503 MODEL_CAPACITY_EXHAUSTED triggers fast endpoint failover
 */

const assert = require('assert');
const { TextEncoder } = require('util');

// Mock objects
const mockAccountManager = {
    getAccountCount: () => 1,
    getAvailableAccounts: () => [{ email: 'test@example.com' }],
    isAllRateLimited: () => false,
    getMinWaitTimeMs: () => 0,
    selectAccount: () => ({ account: { email: 'test@example.com' }, waitMs: 0 }),
    getTokenForAccount: async () => 'mock-token',
    getProjectForAccount: async () => 'mock-project',
    clearExpiredLimits: () => {},
    clearTokenCache: () => {},
    clearProjectCache: () => {},
    notifySuccess: () => {},
    notifyFailure: () => {},
    notifyRateLimit: () => {},
    incrementConsecutiveFailures: () => {},
    getConsecutiveFailures: () => 0,
    markRateLimited: () => {},
    markInvalid: () => {}
};

async function runTests() {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║           ENDPOINT FAILOVER TEST SUITE                       ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    // Import modules
    const { config } = await import('../src/config.js');
    const { sendMessageStream } = await import('../src/cloudcode/streaming-handler.js');
    const { sendMessage } = await import('../src/cloudcode/message-handler.js');
    const { ANTIGRAVITY_ENDPOINT_FALLBACKS } = await import('../src/constants.js');

    // Reduce retries and delays for testing
    config.maxCapacityRetries = 3;
    config.capacityBackoffTiersMs = [10];

    let passed = 0;
    let failed = 0;

    // Helper to run a test
    async function test(name, fn) {
        try {
            console.log(`Running: ${name}...`);
            await fn();
            console.log(`✓ ${name}`);
            passed++;
        } catch (e) {
            console.log(`✗ ${name}`);
            console.log(`  Error: ${e.message}`);
            console.log(e.stack);
            failed++;
        } finally {
            // Cleanup mocks
            delete global.fetch;
        }
    }

    // 503 Error Body
    const capacityErrorBody = JSON.stringify({
        error: {
            code: 503,
            message: "No capacity available for model claude-opus-4-5-thinking on the server",
            status: "UNAVAILABLE",
            details: [
                {
                    reason: "MODEL_CAPACITY_EXHAUSTED",
                    metadata: { model: "claude-opus-4-5-thinking" }
                }
            ]
        }
    });

    // Helper to create a mock stream with content
    function createMockStream(content) {
        const encoder = new TextEncoder();
        const chunks = [
            `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: content }] } }] })}\n\n`
        ];

        return {
            getReader: () => {
                let index = 0;
                return {
                    read: async () => {
                        if (index >= chunks.length) {
                            return { done: true, value: undefined };
                        }
                        return { done: false, value: encoder.encode(chunks[index++]) };
                    }
                };
            }
        };
    }

    // Test 1: sendMessageStream Endpoint Failover
    await test('sendMessageStream should failover to next endpoint on 503 Capacity Exhausted', async () => {
        let calls = [];
        const dailyEndpoint = ANTIGRAVITY_ENDPOINT_FALLBACKS[0]; // daily
        const prodEndpoint = ANTIGRAVITY_ENDPOINT_FALLBACKS[1];  // prod

        // Mock fetch
        global.fetch = async (url, options) => {
            calls.push(url);

            // Daily endpoint -> 503 Capacity Exhausted
            if (url.includes(dailyEndpoint)) {
                return {
                    ok: false,
                    status: 503,
                    text: async () => capacityErrorBody,
                    json: async () => JSON.parse(capacityErrorBody)
                };
            }

            // Prod endpoint -> Success with content
            if (url.includes(prodEndpoint)) {
                return {
                    ok: true,
                    status: 200,
                    body: createMockStream("Stream success")
                };
            }

            return { ok: false, status: 500, text: async () => "Unknown endpoint" };
        };

        const request = {
            model: 'claude-opus-4-5-thinking',
            messages: [{ role: 'user', content: 'hello' }]
        };

        // Run stream
        const generator = sendMessageStream(request, mockAccountManager, false);
        for await (const event of generator) {
            // Consume stream
        }

        // Verification
        assert.strictEqual(calls.length, 2, `Expected 2 calls, got ${calls.length}: ${JSON.stringify(calls)}`);
        assert(calls[0].includes(dailyEndpoint), 'First call should be to Daily');
        assert(calls[1].includes(prodEndpoint), 'Second call should be to Prod');
    });

    // Test 2: sendMessage Endpoint Failover
    await test('sendMessage should failover to next endpoint on 503 Capacity Exhausted', async () => {
        let calls = [];
        const dailyEndpoint = ANTIGRAVITY_ENDPOINT_FALLBACKS[0];
        const prodEndpoint = ANTIGRAVITY_ENDPOINT_FALLBACKS[1];

        // Mock fetch
        global.fetch = async (url, options) => {
            calls.push(url);

            if (url.includes(dailyEndpoint)) {
                return {
                    ok: false,
                    status: 503,
                    text: async () => capacityErrorBody,
                    json: async () => JSON.parse(capacityErrorBody)
                };
            }

            if (url.includes(prodEndpoint)) {
                return {
                    ok: true,
                    status: 200,
                    // sendMessage for thinking models expects a body stream (SSE)
                    body: createMockStream("Message success")
                };
            }

            return { ok: false, status: 500, text: async () => "Unknown endpoint" };
        };

        const request = {
            model: 'claude-opus-4-5-thinking', // Thinking model uses SSE path in sendMessage
            messages: [{ role: 'user', content: 'hello' }]
        };

        // Run message
        await sendMessage(request, mockAccountManager, false);

        // Verification
        assert.strictEqual(calls.length, 2, `Expected 2 calls, got ${calls.length}: ${JSON.stringify(calls)}`);
        assert(calls[0].includes(dailyEndpoint), 'First call should be to Daily');
        assert(calls[1].includes(prodEndpoint), 'Second call should be to Prod');
    });

    console.log('\n' + '═'.repeat(60));
    console.log(`Tests completed: ${passed} passed, ${failed} failed`);

    if (failed > 0) {
        process.exit(1);
    } else {
        process.exit(0);
    }
}

runTests().catch(err => {
    console.error('Test suite failed:', err);
    process.exit(1);
});
