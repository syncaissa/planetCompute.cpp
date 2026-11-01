# Reliability: no single point of failure, and why there is no load balancer

Short answers to the questions people ask first. The details and numbers are in the paper (section
"Orchestration and Privacy", paragraph "Faults", table "The orchestrator under faults"), and the test
is test 14 in [TESTING.md](TESTING.md).

## Why is there no load balancer?

Because Cloudflare already is one, and it sits in front of everything:

- Every request (a volunteer's device, a Harness user, the website) reaches the nearest Cloudflare data
  centre. This is how Cloudflare works (anycast), not something we built.
- The gateway (a Cloudflare Worker) keeps no state. It runs wherever the request lands, and Cloudflare adds
  capacity by itself.
- The parts that do keep state are Durable Objects: many small objects (jobs, lane shards, directories).
  Each one lives in one place at a time. When a machine fails, Cloudflare starts the object again on
  another machine.

So there is no server of ours that receives the requests and could become overloaded or fail.

## Is there a queue?

Not a queue service. The same protection comes from four rules:

1. **The sender keeps a message until it is acknowledged**, and sends it again after growing pauses
   (0.2 s, then longer, up to 10 s). A Harness user's program resends a job under the job ID it chose. A
   device resends its answer.
2. **Every message has an ID.** The receiver drops a repeat, so resending never counts anything twice
   (no double credit, no double job).
3. **An object saves its state before it answers.** A restart loses only its connections and a few seconds.
4. **A job hands out a copy again when the answer is long overdue.** This covers whatever happened in
   between (a device switched off, a message lost).

Credit writes also keep a transaction ID in a condition, so the ledger cannot add the same credit twice.

The "queue" is therefore each sender's own short list of messages it has not had acknowledged. It is not
one central queue, which would be a bottleneck and could fail.

## Single points of failure, part by part

| Part | How many | If it fails |
|---|---|---|
| Gateway (Worker) | runs in every Cloudflare data centre | nothing: the next request runs elsewhere |
| Jobs, lane shards, directories (Durable Objects) | many, each small | that object restarts elsewhere; state was saved first; a few seconds lost |
| Planner (Durable Object) | one | advisory only: the gateway keeps the last plan, devices keep working, only rebalancing between lanes pauses |
| Credit ledger (DynamoDB) | AWS regional service | throttling delays credit; it is never lost or doubled |
| Cloudflare itself | one provider | the grid stops; devices keep unsent answers and resend when it returns. Accepted risk, as for any service on one provider |

## What we tested

The orchestrator simulator (gridSim) ran 20,000 devices for one hour with faults switched on:

- 1 % of requests between objects refused (an object overloaded or restarting);
- 0.2 % of WebSocket messages lost;
- 0.5 crashes per object per hour, with its memory lost;
- 0.2 % of replies lost after delivery, so the sender cannot tell whether its message arrived.

| Design | Jobs finished | Jobs lost | Credit wrong | Processed twice |
|---|---|---|---|---|
| Nothing retried | 4,360 of 6,573 | 493 | 10,202 units missing | 0 |
| Retries without message IDs | 6,167 of 6,584 | 113 | 1,123 units paid twice | 6,095 |
| **Simple design (the four rules)** | **6,426 of 6,637** | **0** | **0 of 1,051,195** | **0** (6,447 repeats dropped) |

The simple design lost nothing and counted nothing twice, and the simulator's cost estimate did not rise (fewer stuck jobs means less wasted work). Its price is
about 1,400 storage writes per second at 20,000 devices (rule 3).

## What changes if you do not use Cloudflare

If you run PlanetCompute on your own servers instead of Cloudflare or a similar platform, you must supply
what Cloudflare provides:

- **Load balancers**: at least two, with health checks and a floating address (for example HAProxy or
  nginx), sending each device's connection to the server that owns its lane shard.
- **A durable queue or message broker** between the servers (for example NATS JetStream, RabbitMQ or Redis
  Streams) for incoming jobs and results, so a server that fails mid-message loses nothing.
- **Restart elsewhere**: a lease with a fencing token for each object (etcd or PostgreSQL), so another server
  takes over an object and a stale owner cannot write.

The paper's section "No Vendor Lock-In: Running on Plain Ubuntu Servers" lists the open-source pieces.
