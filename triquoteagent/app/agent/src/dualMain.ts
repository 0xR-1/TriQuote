import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { GetSecretValueCommand, SecretsManagerClient, } from "@aws-sdk/client-secrets-manager";
import { DefaultRequestHandler, InMemoryTaskStore } from "@a2a-js/sdk/server";
import { agentCardHandler, jsonRpcHandler, UserBuilder, } from "@a2a-js/sdk/server/express";
import { loadStudioToml, type TomlTable, } from "@bnbagent/studio-runtime/config";
import { ensureAltanaSessionLoaded, ensureKeystoreMaterialized, ensureTwakMaterialized, getWallet, } from "@bnbagent/studio-runtime/wallet";
import { createEnvelopeMiddleware, b402SellPath, type B402HttpRequest, type B402RunWork, B402Seller, } from "@bnbagent/studio-runtime/b402";
import { resolveStorageMode } from "@bnbagent/studio-runtime/storage";
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { buildAgentCard } from "./agentCard.js";
import { SellerAgentExecutor } from "./executor.js";
import { buildMcpServer } from "./mcpMain.js";
import { requestLimitContext, limitCommerceOperation as limitSellOperation, isCommerceRateLimitError as isSellRateLimitError, } from "./requestLimits.js";
import type { RunWork } from "./sellerCore.js";
import { buildTriQuoteWork } from "./triquoteWork.js";
const APP_NAME = "agent";
function generatorTag(): string {
    let name = "";
    try {
        const cfg = loadStudioToml();
        name = String(((cfg.project ?? {}) as Record<string, unknown>).name ?? "");
    }
    catch {
        return APP_NAME;
    }
    return name.endsWith("-agent")
        ? name.slice(0, -"-agent".length)
        : name || APP_NAME;
}
async function loadRuntimeSecrets(): Promise<void> {
    const secretId = process.env.BNBAGENT_RUNTIME_SECRET_ID;
    if (!secretId) {
        return;
    }
    const resp = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: secretId }));
    const bundle = JSON.parse(resp.SecretString ?? "{}") as Record<string, unknown>;
    for (const [key, value] of Object.entries(bundle)) {
        process.env[key] = String(value);
    }
    const pieverseKey = process.env.PIEVERSE_LLM_API_KEY;
    if (pieverseKey) {
        const fingerprint = createHash("sha256")
            .update(pieverseKey, "utf-8")
            .digest("hex")
            .slice(0, 12);
        console.info(`[runtime-secrets] PIEVERSE_LLM_API_KEY source=secretsmanager sha256=${fingerprint}…`);
    }
}
function defaultNetwork(): string {
    try {
        const cfg = loadStudioToml();
        return String(((cfg.network ?? {}) as Record<string, unknown>).default ?? "bsc-testnet");
    }
    catch {
        return "bsc-testnet";
    }
}
export function buildRunWork(): RunWork {
    return buildTriQuoteWork();
}
function hasErc8183Rail(cfg: TomlTable): boolean {
    const payments = asTable(cfg.payments);
    const rail = asTable(payments?.erc8183);
    return rail !== null && rail.enabled !== false;
}
function asTable(value: unknown): TomlTable | null {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as TomlTable)
        : null;
}
function flatHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) {
        if (typeof value === "string")
            out[name] = value;
        else if (value !== undefined)
            out[name] = value[0] ?? "";
    }
    return out;
}
function flatQuery(query: Record<string, unknown>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(query)) {
        if (typeof value === "string")
            out[name] = value;
    }
    return out;
}
function b402Work(runWork: RunWork): B402RunWork {
    return ({ prompt }) => runWork(prompt, { sessionId: "b402" });
}
export async function buildDualApp(): Promise<{
    app: express.Express;
    executor: SellerAgentExecutor;
}> {
    await loadRuntimeSecrets();
    ensureKeystoreMaterialized();
    ensureTwakMaterialized();
    await ensureAltanaSessionLoaded();
    const cfg = loadStudioToml();
    const rails = { erc8183: hasErc8183Rail(cfg) };
    if (rails.erc8183)
        resolveStorageMode(cfg);
    const sellPath = b402SellPath(cfg);
    const port = Number(process.env.AGENT_PORT || "9000");
    const runWork = buildRunWork();
    const executor = new SellerAgentExecutor({
        runWork,
        generator: generatorTag(),
        network: defaultNetwork(),
        commerceSkills: rails.erc8183,
    });
    const agentCard = buildAgentCard({ commerceSkills: rails.erc8183 });
    const seller = await B402Seller.create({
        cfg,
        runWork: b402Work(runWork),
        walletAddress: getWallet().address,
        resourceUrl: `${process.env.AGENTCORE_RUNTIME_URL ?? `http://localhost:${port}`}${sellPath}`,
    });
    const handler = new DefaultRequestHandler(agentCard, new InMemoryTaskStore(), executor);
    const app = express();
    app.use(requestLimitContext);
    app.get("/ping", (_req, res) => {
        res.json({ status: executor.isBusy() ? "HEALTHY_BUSY" : "HEALTHY" });
    });
    if (seller.state !== "disabled") {
        app.all(sellPath, express.text({ type: "*/*", limit: "1mb" }), async (req, res) => {
            const request: B402HttpRequest = {
                method: req.method,
                path: req.path,
                query: flatQuery(req.query),
                headers: flatHeaders(req.headers),
                body: typeof req.body === "string"
                    ? req.body
                    : JSON.stringify(req.body ?? ""),
            };
            try {
                await limitSellOperation("sell");
            }
            catch (error) {
                res.status(isSellRateLimitError(error) ? 429 : 503)
                    .json({ error: "seller request limit reached" });
                return;
            }
            const out = await seller.handle(request);
            res.status(out.status).set(out.headers).send(out.body);
        });
    }
    app.use(express.json({ limit: "8mb" }));
    app.use(createEnvelopeMiddleware({ port }));
    app.use("/.well-known/agent-card.json", agentCardHandler({ agentCardProvider: handler }));
    const transports: Record<string, StreamableHTTPServerTransport> = {};
    app.all("/mcp", async (req, res) => {
        const sessionId = req.headers["mcp-session-id"] as string | undefined;
        let transport = sessionId ? transports[sessionId] : undefined;
        if (transport === undefined) {
            if (req.method !== "POST" || !isInitializeRequest(req.body)) {
                res.status(400).json({
                    jsonrpc: "2.0",
                    error: { code: -32000, message: "Bad Request: no valid session" },
                    id: null,
                });
                return;
            }
            const t = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                enableJsonResponse: true,
                onsessioninitialized: (sid) => {
                    transports[sid] = t;
                },
            });
            t.onclose = () => {
                if (t.sessionId !== undefined) {
                    delete transports[t.sessionId];
                }
            };
            await buildMcpServer({
                commerceSkills: rails.erc8183,
                runWork,
            }).connect(t);
            transport = t;
        }
        await transport.handleRequest(req, res, req.body);
    });
    app.use(jsonRpcHandler({
        requestHandler: handler,
        userBuilder: UserBuilder.noAuthentication,
    }));
    return { app, executor };
}
async function main(): Promise<void> {
    const host = process.env.AGENT_BIND_HOST || "0.0.0.0";
    const port = Number(process.env.AGENT_PORT || "9000");
    const { app } = await buildDualApp();
    app.listen(port, host, () => {
        console.log(`[seller-agent] A2A native + MCP tunneled serving on ${host}:${port}`);
    });
}
const isMain = process.argv[1] !== undefined &&
    import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
    main().catch((e) => {
        console.error("[seller-agent] fatal:", e);
        process.exit(1);
    });
}
