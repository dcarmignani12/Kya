import { createFileRoute } from "@tanstack/react-router";
import type { AgentEvent } from "~/lib/domain";
import { parseAgentRequest, runAgent } from "~/server/agent.server";

// POST /api/agent — streams NDJSON AgentEvents (text, thinking, tool-call,
// tool-result, ledger, error, done) while Atlas works.
export const Route = createFileRoute("/api/agent")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let history;
        try {
          history = parseAgentRequest(await request.json());
        } catch (err) {
          return Response.json({ error: `invalid request: ${(err as Error).message}` }, { status: 400 });
        }
        const encoder = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
          async start(controller) {
            const emit = (event: AgentEvent) => {
              try {
                controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
              } catch {
                // client went away
              }
            };
            try {
              await runAgent(history, emit, request.signal);
            } catch (err) {
              emit({ type: "error", message: (err as Error).message ?? String(err) });
            } finally {
              try {
                controller.close();
              } catch {
                // already closed
              }
            }
          },
        });
        return new Response(body, {
          headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" },
        });
      },
    },
  },
});
