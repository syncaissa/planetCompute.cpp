# generouscows: always-on "Contribute Compute" on our own servers

> **RETIRED 30 October 2026.** Replaced by SupplySimulation on an in-house SherpaHub (docs/SHERPAHUB.md, paper section "In-House SherpaHubs"). Kept as a record; see ../README.md.

The opposite of the hungrywolves (docs/HUNGRYWOLVES.md: scripts that *receive* compute by sending chat jobs). The
generouscows *contribute*: copies of the planetCompute server build, always running, sharing their cores with the pool
and answering grid jobs, so a receiver gets an answer at any hour, even when no volunteer is online.

They are a workhorse row (docs/WORKHORSES.md) of their own, on the same server, with their own folder, ports and account:

| Setting | Value |
|---|---|
| Server | InterServer 203.0.113.10 (same machine as the workhorse and the wolves) |
| Folder | `/root/REMOTESERVERSACCESS/generouscows` (sibling of hungrywolves; nothing outside it except one @reboot line) |
| Copies x cores | 2 x 2 (admin page, Workhorses: change any time) |
| Ports | `port_base` 7540: copies on 7541, 7542 (the workhorse uses 7531, 7532) |
| Account | support@planetcompute.ai (its Compute Credit and bonus go there) |
| Wallet | the account's Solana address = the payout wallet, so the bonus the cows earn goes back where payouts come from |
| Boot | `--boot`: one crontab line tagged `# planetcompute generouscows` (the workhorse keeps its own line) |

Install / update (after the row exists on the admin page, tab Workhorses):

    python3 scripts/startWorkhorseOnAnyServer.py --server-id <cows row ID> --boot

Control: the admin page (Start / Restart / Stop, copies, cores), or on the server `/root/REMOTESERVERSACCESS/generouscows/whctl status|logs|restart`.

Limits: the capacity check credits at most 8 devices per network address; workhorse 2 + cows 2 = 4.
