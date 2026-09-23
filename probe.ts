process.env.OPENCODE_OTEL_DIAG_LOG = "/tmp/otel-probe-diag.log";
const got: string[] = [];
const server = Bun.serve({ port: 4330, async fetch(r){ got.push(new URL(r.url).pathname); await r.text(); return new Response("",{status:200}); }});
const mod: any = await import("./src/index.ts");
const hooks: Record<string,Function> = {};
const events: any[] = [];
let closed = false;
const ctx: any = {
  options: { enabled: true, endpoint: "http://127.0.0.1:4330", protocol: "http/json", metricsInterval: 1000, logsInterval: 500, logsEnabled: true, metricPrefix: "opencode." },
  location: { directory: process.cwd(), project: { id: "p", canonical: process.cwd() } },
  session: { hook: async (n:string,c:Function)=>{hooks[n]=c;return{dispose:async()=>{}};}, get: async()=>({agent:"build",model:{id:"m",providerID:"p"}}) },
  event: { subscribe: () => ({ [Symbol.asyncIterator]: () => { let i=0; return { next: async () => { while (i>=events.length) { if (closed) return {done:true,value:undefined}; await new Promise(r=>setTimeout(r,10)); } return {done:false, value: events[i++]} } } } }) },
};
const cleanup = await mod.default.setup(ctx);
console.log("hooks:", Object.keys(hooks));
await hooks.prompt({ sessionID: "ses_x", messageID: "msg_u", prompt: { text: "hi" } });
events.push(
  { type:"session.execution.started", created:Date.now(), data:{sessionID:"ses_x"} },
  { type:"session.step.started", created:Date.now(), data:{sessionID:"ses_x", assistantMessageID:"msg_a", agent:"build", model:{id:"m",providerID:"p"}, started:Date.now()} },
  { type:"session.step.ended", created:Date.now(), data:{sessionID:"ses_x", assistantMessageID:"msg_a", finish:"stop", cost:0.001, tokens:{input:1,output:1,reasoning:0,cache:{read:0,write:0}} } },
  { type:"session.execution.succeeded", created:Date.now(), data:{sessionID:"ses_x"} },
);
await new Promise(r=>setTimeout(r,1500));
await cleanup();
await new Promise(r=>setTimeout(r,500));
server.stop(true);
console.log("received:", got);
