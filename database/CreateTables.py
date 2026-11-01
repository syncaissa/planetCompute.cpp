#!/usr/bin/env python3
"""Create PlanetCompute's DynamoDB tables (idempotent: existing tables are left alone).

Credentials and settings come from the environment or from ./.env (never from this file):
    AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, DYNAMODB_TABLE_PREFIX (default planetcompute-ai-)

Usage:
    pip install boto3
    python CreateTables.py            # create missing tables, wait until ACTIVE
    python CreateTables.py --dry-run  # print the table definitions only

Tables
------
Designed for millions of users, devices and sessions: no admin list or request path scans a table. Every
list is a Query on a global secondary index (GSI) followed by one BatchGetItem for the page. List indexes
are KEYS_ONLY, so an update that does not change an index key writes nothing to the index, and their
partition keys are spread by month, by day or by shard so no single key takes more than a few writes a
second. All tables: on-demand billing, point-in-time recovery, deletion protection, KMS encryption at rest.

<prefix>user
    Accounts, email addresses, one-time codes, sessions, devices and counters (single-table design).
    A user's ID is 12 random hex digits, never the email, so addresses can be added, removed or swapped.

    Keys: pk (S) partition key, sk (S) sort key
      pk "USER#<user_id>"        sk "PROFILE"            user_id, primary_email, first_name, last_name, created_at,
                                                         last_login_at, status, IsAdmin, email_count, device_count,
                                                         last_seen, last_state, + index keys below
      pk "USER#<user_id>"        sk "EMAIL#<email>"      email, added_at, verified_at
      pk "USER#<user_id>"        sk "DEVICE#<device_id>" the latest status report of a device (see the website code)
      pk "USER#<user_id>"        sk "WLINK"              pending wallet link (ttl)
      pk "EMAIL#<email>"         sk "EMAIL"              user_id   (unique: one account per address)
      pk "OTP#<purpose>#<email>" sk "OTP"                code_hash, expires_at, attempts, sends, window_start, ttl
      pk "SESSION#<token_hash>"  sk "SESSION"            user_id, created_at, expires_at, ttl
      pk "STATS"                 sk "COUNTS"             users, devices, contributor_sessions (running totals)
    Codes and session tokens are stored only as salted SHA-256 hashes; no passwords exist.

    Global secondary indexes (all KEYS_ONLY; sparse: only items with the attributes appear)
      by-user              user_id   / sk         every item of a user (removal, sign out everywhere)
      users-by-month       ulist_pk  / ulist_sk   "U#<YYYY-MM>" / "<created_at>#<id>": newest accounts first
      users-by-first-name  fname_pk  / fname_sk   "FN#<2 letters>" / "first last": name prefix search
      users-by-last-name   lname_pk  / lname_sk   "LN#<2 letters>" / "last first"
      emails-by-prefix     eml_pk    / eml_sk     "EM#<2 letters>" / email (on EMAIL# items, + user_id): email prefix search
      admins               admin_pk  / user_id    "ADMIN" on admin profiles (makeThisUserAdmin.py)
      devices-by-month     dev_pk    / dev_sk     "D#<YYYY-MM of first report>" / "<first_seen>#<user>#<device>"
      devices-live         live_pk   / live_sk    "LIVE#<5-minute bucket>#<shard 0-7>" / "<user>#<device>":
                                                  devices that reported recently; a device moves once per 5 minutes

    Time to live on attribute "ttl" removes expired codes, sessions and devices silent for 90 days.

<prefix>user-credits
    Compute Credit and token balances: one BALANCE item per user plus an append-only ledger.
    Work Units are integers in micro-WU (1 WU = 10^6 uWU); token amounts are integers in base units.

    Keys: user_id (S) partition key, sk (S) sort key
      user_id <id>                  sk "BALANCE"        lifetime_contribution_uwu, lifetime_redeemed_uwu, available_uwu,
                                                        lifetime_redeemed_npcc, balance_npcc, transferred_npcc,
                                                        wallet_address, updated_at
      user_id <id>                  sk "TX#<kind>#<id>" ledger entry: kind, wu_uwu, amount_npcc, status, signature,
                                                        rule_id, created_at, tx_day
      user_id <id>                  sk "DEPREF#<ref>"   a deposit reference waiting for its transaction
      user_id "DEPOSIT#<signature>" sk "DEPOSIT"        a deposit already credited (never twice)
      user_id "WALLET#<address>"    sk "WALLET"         owner (one account per wallet)
      user_id "EPOCH"               sk "EPOCH#<n>"      root, signature, accounts, memo, at
      user_id "EPOCH#<n>#<user>"    sk "LEAF"           balance_npcc, available_uwu, leaf, proof (Merkle path)

    Global secondary indexes
      by-pack    pack_id / user_id         (ALL)        every credit for one WorkPack (orchestrator: audits)
      by-device  device_id / created_at    (ALL)        everything a device was credited (ban reversal)
      by-wallet  wallet_address / user_id  (KEYS_ONLY)  the account behind a wallet
      tx-by-day  tx_day / created_at       (KEYS_ONLY)  every ledger entry of one day (audits)

<prefix>Contributor-Sessions
    The evidence behind every credited Work Unit: one row per console session from one IP address, updated by
    each status report (once a minute). A new IP address or a reloaded console starts a new row.

    Keys: user_id (S) partition key, sk (S) sort key "CS#<started_at ISO-8601>#<session_id>-<ip hash>"
      started_at, last_at, ended_at, last_state, device_id, session_id,
      ip, ip_version, country, region, city, postal_code, timezone, latitude, longitude, asn, as_org, colo,
      http_protocol, tls_version, user_agent, browser, platform, host, hw_cores, device_mem_gb, cores, cpu_cap,
      cpu_pct, gpu_on, gpu_name, gpu_cap, gpu_pct, mem_mb, packs, reported_wu_total,
      police_verified, verified_cpu_wu_s, verified_gpu_wu_s, police_fails, police_last, last_note,
      counters (ADD): beats, reported_uwu, credited_uwu, uncredited_uwu, running_s, idle_s

    Global secondary indexes (all KEYS_ONLY)
      sessions-by-day  day_pk / day_sk         "DAY#<YYYY-MM-DD>" / "<started_at>#<user>#<id>": newest first
      by-device        device_id / started_at  every session of a device
      by-ip            ip / started_at         every session from one IP address (many accounts, one address)

<prefix>howCreditAwarded
    How Compute Credit is awarded: effective-dated rules plus a full audit trail. Rules are never edited or
    deleted. A change is a NEW rule with a future effective date; a rule that has not started yet can be
    cancelled (marked, not deleted). The rule in force at time t is the latest non-cancelled rule whose
    effective_from <= t. Every create, cancel and seed writes an AUDIT item. Small: queried by partition.

    Keys: pk (S), sk (S)
      pk "RULE"   sk "<effective_from ISO-8601 UTC>#<rule_id>"
                  rule_id, effective_from, credit_per_wu (N), first_finisher_share (N), note, status
                  (active | cancelled), created_by, created_by_email, created_at, cancelled_by, cancelled_at
      pk "RATING" sk "<effective_from>#<rule_id>"   machine-rating sets (bands, standby fraction, police interval)
      pk "AUDIT"  sk "<ISO-8601 UTC>#<audit_id>"
                  action, rule_id, by, by_email, at, before (JSON), after (JSON)
    The table is seeded with one rule and one rating set when it is first created.

<prefix>ledger-options
    The coins the bonus is paid in (one or more, from a pool), and what share of the bonus each coin gets. A coin is
    added once and switched active / inactive. Share sets are effective-dated like the credit rules: never edited;
    a change is a NEW set with a future effective date; one not started yet can be cancelled. The set in force at
    time t is the latest non-cancelled set whose effective_from <= t; its shares add up to 100 %. Every change
    writes an AUDIT item. Seeded with PlanetComp, active, 100 % from the moment the table is created.

    Keys: pk (S), sk (S)
      pk "COIN"   sk "<coin_id>"   coin_id, name, symbol, mint_mainnet, decimals, token_program (token | token-2022),
                                   address_from (the wallet the coin is sent from: a public address, never a key),
                                   mint_devnet, decimals_devnet, address_from_devnet, status (active | inactive), note,
                                   created_*, updated_*
      pk "SET"    sk "<effective_from ISO-8601 UTC>#<set_id>"
                                   set_id, effective_from, shares (JSON [{coin_id, pct}]), note, status
                                   (active | cancelled), created_by, created_by_email, created_at, cancelled_*
      pk "AUDIT"  sk "<ISO-8601 UTC>#<audit_id>"   action, by, by_email, at, before (JSON), after (JSON)

<prefix>address-audit
    Every change of an account's Solana wallet address (the current one is on the user table, PROFILE item:
    solana_address, solana_address_at). Written by the website when the owner updates the address (profile panel or
    My Balance); never edited. Read by the "Previous addresses" button.

    Keys: user_id (S) partition key, sk (S) sort key "<changed_at ISO-8601 UTC>#<id>"
      old_address ("" for the first one), new_address, changed_at, old_since (when the old one was set), ip, user_agent

<prefix>crypto-allowed
    The confirmation next to "Your Solana wallet address" on My Balance (website and program): "I confirm that
    cryptocurrency transactions are permitted in my country, and I accept responsibility for complying with local
    laws." Every check AND uncheck is a new row (never edited); the account's latest row sets the box when the page
    loads. Unchecked (or no row): the wallet part of My Balance is hidden.

    Keys: user_id (S) partition key, sk (S) sort key "<at ISO-8601 UTC>#<id>"
      at, allowed (BOOL), text (the sentence as shown), email, country (Cloudflare), ip, user_agent, via (website | program)

<prefix>token-risk-accepted
    The second statement on My Balance: "I understand that [Token Name] is a ledger record only, may have no real value,
    and could lose 100% of any value it ever has. I accept it at my own discretion and risk." ([Token Name] = the coin(s)
    of the share set in force). Once checked it cannot be unchecked: one row per account, written once (conditional put),
    never changed.

    Keys: user_id (S) partition key, sk (S) sort key "ACCEPTED"
      at, accepted (BOOL true), token_name, text (as shown), email, country (Cloudflare), ip, user_agent, via (website | program)

<prefix>media-made
    The registry of pictures and videos made with planetCompute, per account (user 2026-10-30: only what was made here can
    be saved to the cloud). The program registers each one the moment it makes it (POST /api/media/made, with the file's
    SHA-512 and how it was made); a pool picture or video is registered by the site when its owner fetches it. Save to cloud
    (/api/uploads) hashes the file it receives and keeps it only if this account has that SHA-512 here; otherwise "This
    picture or video was not made here". The first registration of a file is kept (conditional put).

    Keys: user_id (S) partition key, sk (S) sort key "SHA512#<128 hex>"
      at, bytes, kind (image | video), name, via (program | pool | api), device, model, prompt, negative, seed, width, height,
      steps, seconds, ran_on, app

<prefix>models
    The model library's master list (open models only: images, video, music, chat, coding), filled by
    planetCompute-CPP/scripts/models_table.py and read by the admin page's Models tab; the editions (provenance added,
    weights unchanged) are built from it by planetCompute-CPP/scripts/models_editions.py.

    Keys: model_id (S) partition key, sk (S) sort key
      model_id "<id>"   sk "MODEL"   category (Image | Video | Music | Chat | Coding), name, license, license_url,
                                     allowed (true: open licence that allows commercial use and redistribution),
                                     conditions, engine (llama.cpp | stable-diffusion.cpp | not yet), in_app,
                                     files_json (each file: role, repo, revision, path, bytes, sha256, format),
                                     total_bytes, min_ram_gb, status (listed | pending | building | built | error |
                                     excluded), status_note, edition_json (per file: b2 key, original / edition /
                                     weights-only SHA-256, fields added), cat_sk, created_at, updated_at, updated_by
    Index:
      models-by-category  (category, cat_sk = "<name lower case>#<id>")   the Models tab, one category at a time

<prefix>bugs-reported
    Bug reports from the "Report Bugs" pop-up on the home page, with their status and the admins' log.

    Keys: pk (S) "BUG#<bug_id>", sk (S) "BUG"
      bug_id, created_at, updated_at, status (new | confirmed | in_progress | on_hold | fixed | wont_fix | duplicate |
      closed), status_by, user_id (signed-in reporters only), email, name, subject, description, area, severity,
      page, screen, user_agent, ip, country, city, as_org,
      comments (JSON list, oldest first: status changes, admins' comments and emails to the reporter, each with
      its time and the admin)

    Global secondary indexes (all KEYS_ONLY)
      bugs-by-month   list_pk / list_sk     "B#<YYYY-MM>" / "<created_at>#<bug_id>": newest first
      bugs-by-status  status_pk / list_sk   "S#<status>" / "<created_at>#<bug_id>": one status, newest first
      by-user         user_id / created_at  one account's reports

<prefix>HeartbeatEtcEC2TypeServers
    Our own always-on servers (EC2-type machines, e.g. Hetzner or AWS) that take the volunteers' heartbeats first,
    behind Cloudflare's proxy; when none answers, the volunteer reports to the website as before
    (CostOfComputeCFetc.txt). Edited on the admin page, tab Servers. A handful of rows: read with a Scan.
    NO SECRETS HERE: the SSH private key stays on the admin machine (ssh_key_name only names it); the shared
    secret between the website and the servers is the Worker secret HB_SERVER_SECRET.

    Keys: server_id (S), sk (S) "SERVER"
      name, role (heartbeat), status (active | inactive), hostname (the HTTPS name volunteers use, e.g.
      hb1.planetcompute.ai), public_ipv4, public_ipv6, provider, region, instance_type, ssh_user, ssh_port,
      ssh_key_name, weight (higher = tried first), notes, health (ok | down | unknown), last_check_at, last_ok_at,
      last_error, latency_ms, version, created_at, created_by, updated_at, updated_by

<prefix>Workhorses
    Our own always-on Ubuntu servers that run 1-6 headless planetCompute copies (the server build) sharing compute
    with the pool around the clock (until enough users share). Edited on the admin page, tab Workhorses; read with a
    Scan. NO SECRETS HERE: the SSH private key stays on the admin machine (ssh_key_name only names it); the agent
    on the server signs its reports with the Worker secret HB_SERVER_SECRET.

    Keys: server_id (S), sk (S) "SERVER"
      name, public_ipv4, ssh_user, ssh_port, ssh_key_name, root_dir, instances (1-6), cores (per copy, empty =
      half the machine), cap (%), account_email, account_user_id (the copies sign in as this account), provider,
      notes, desired_state (running | stopped), cmd, cmd_seq, auto_restart, agent_seen_at, agent_state (JSON),
      session_issued_at, control_at, control_by, created_at, created_by, updated_at, updated_by

<prefix>model-agreements
    Licence agreements for library models whose licence passes use rules on to every user (Llama 3.3, LTX-2.x,
    Stability AI Community, OpenRAIL++): the planetCompute program asks before the first download, and the site serves
    such a model's files only to accounts with an item here (LICENCE_AGREEMENTS in the website code).

    Keys: user_id (S), sk (S) "<model_id>#<licence>#<licence_version>"
      email, model_id, model_name, licence, licence_title, licence_version, licence_url, accepted (true), accepted_at,
      ip, country, city, user_agent, via (planetCompute program), email_sent_at (the confirmation emailed to the user)

    Global secondary index (KEYS_ONLY)
      by-model   model_id / accepted_at   everyone who accepted one model's licence

<prefix>reported-media
    Pictures, videos and songs reported on their shared page (planetcompute.ai/u/<token>: the Report pop-up, or the
    contact form's "Report abuse"), with the owner and real file name found from the link, the status and the admins'
    log (admin page, tab Reported media; its lookup also shows any link's owner and file name).

    Keys: pk (S) "REPORT#<report_id>", sk (S) "REPORT"
      report_id, created_at, updated_at, status (new | reviewing | taken_down | no_action | closed), status_by,
      url, token, owner_user_id, owner_email, file_name, file_state (live | trash | deleted | not found, when reported),
      reason, source (Report button | contact form), reporter_name, reporter_email, reporter_user_id (signed in),
      message, ip, country, city, as_org, user_agent,
      comments (JSON list, oldest first: status changes and admins' comments, each with its time and the admin)

    Global secondary indexes (all KEYS_ONLY)
      reports-by-month   list_pk / list_sk          "R#<YYYY-MM>" / "<created_at>#<report_id>": newest first
      reports-by-status  status_pk / list_sk        "S#<status>" / "<created_at>#<report_id>"
      by-token           token / created_at         one shared file's reports
      by-owner           owner_user_id / created_at one owner's reported files

Recreating tables (deletes their data; an on-demand backup is taken first):
    python CreateTables.py --recreate user,user-credits,Contributor-Sessions --keep-users 0123456789ab,ba9876543210
--keep-users copies those accounts (profile, email addresses, sign-in sessions) into the new table, so their
user IDs, names and admin flags stay and they remain signed in. Devices, codes and credits are not kept.

"""
import argparse
import os
import pathlib
import sys
import time


def load_dotenv(path=pathlib.Path(__file__).resolve().parent / ".env"):
    """Minimal .env reader (KEY=VALUE lines); real environment variables win."""
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def S(name):
    return {"AttributeName": name, "AttributeType": "S"}


def gsi(name, pk, sk, projection="KEYS_ONLY", include=None):
    return {
        "IndexName": name,
        "KeySchema": [{"AttributeName": pk, "KeyType": "HASH"}, {"AttributeName": sk, "KeyType": "RANGE"}],
        "Projection": {"ProjectionType": "INCLUDE", "NonKeyAttributes": include} if include else {"ProjectionType": projection},
    }


# First rule: sized so that 200 M coins last 40 years with 50 M volunteers at 5 h/day, each averaging 5% of
# the reference GPU (180 Work Units per hour): 200e6 / (50e6 * 5 * 365.25 * 40 * 180) = 3.04e-7, rounded down.
SEED_RULE = {
    "effective_from": "2026-10-01T00:00:00Z",
    "credit_per_wu": "0.0000003",
    "first_finisher_share": "0.5",
    "note": "Initial rule: 200M coins over 40 years, 50M volunteers x 5 h/day, average 0.05 reference-GPU (180 WU/h).",
}


def table_definitions(prefix):
    common = {"BillingMode": "PAY_PER_REQUEST", "SSESpecification": {"Enabled": True, "SSEType": "KMS"},
              "DeletionProtectionEnabled": True}
    keys = lambda pk, sk: [{"AttributeName": pk, "KeyType": "HASH"}, {"AttributeName": sk, "KeyType": "RANGE"}]
    tags = lambda what: [{"Key": "project", "Value": "planetcompute"}, {"Key": "data", "Value": what}]
    return [
        {
            "TableName": f"{prefix}user", **common,
            "AttributeDefinitions": [S(a) for a in ("pk", "sk", "user_id", "ulist_pk", "ulist_sk", "fname_pk", "fname_sk",
                                                    "lname_pk", "lname_sk", "eml_pk", "eml_sk", "admin_pk",
                                                    "dev_pk", "dev_sk", "live_pk", "live_sk")],
            "KeySchema": keys("pk", "sk"),
            "GlobalSecondaryIndexes": [
                gsi("by-user", "user_id", "sk"),
                gsi("users-by-month", "ulist_pk", "ulist_sk"),
                gsi("users-by-first-name", "fname_pk", "fname_sk"),
                gsi("users-by-last-name", "lname_pk", "lname_sk"),
                gsi("emails-by-prefix", "eml_pk", "eml_sk", include=["user_id"]),   # user_id never changes
                gsi("admins", "admin_pk", "user_id"),
                gsi("devices-by-month", "dev_pk", "dev_sk"),
                gsi("devices-live", "live_pk", "live_sk"),
            ],
            "Tags": tags("accounts"), "_ttl": "ttl",
        },
        {
            "TableName": f"{prefix}user-credits", **common,
            "AttributeDefinitions": [S(a) for a in ("user_id", "sk", "pack_id", "device_id", "created_at",
                                                    "wallet_address", "tx_day")],
            "KeySchema": keys("user_id", "sk"),
            "GlobalSecondaryIndexes": [
                gsi("by-pack", "pack_id", "user_id", "ALL"),
                gsi("by-device", "device_id", "created_at", "ALL"),
                gsi("by-wallet", "wallet_address", "user_id"),
                gsi("tx-by-day", "tx_day", "created_at"),
            ],
            "Tags": tags("credits-ledger"),
        },
        {
            "TableName": f"{prefix}Contributor-Sessions", **common,
            "AttributeDefinitions": [S(a) for a in ("user_id", "sk", "day_pk", "day_sk", "device_id", "started_at", "ip")],
            "KeySchema": keys("user_id", "sk"),
            "GlobalSecondaryIndexes": [
                gsi("sessions-by-day", "day_pk", "day_sk"),
                gsi("by-device", "device_id", "started_at"),
                gsi("by-ip", "ip", "started_at"),
            ],
            "Tags": tags("contributor-sessions"),
        },
        {
            "TableName": f"{prefix}howCreditAwarded", **common,
            "AttributeDefinitions": [S("pk"), S("sk")],
            "KeySchema": keys("pk", "sk"),
            "Tags": tags("credit-rules"), "_seed": "credit_rules",
        },
        {
            "TableName": f"{prefix}address-audit", **common,
            "AttributeDefinitions": [S("user_id"), S("sk")],
            "KeySchema": keys("user_id", "sk"),
            "Tags": tags("address-audit"),
        },
        {
            "TableName": f"{prefix}crypto-allowed", **common,
            "AttributeDefinitions": [S("user_id"), S("sk")],
            "KeySchema": keys("user_id", "sk"),
            "Tags": tags("crypto-allowed"),
        },
        {
            "TableName": f"{prefix}token-risk-accepted", **common,
            "AttributeDefinitions": [S("user_id"), S("sk")],
            "KeySchema": keys("user_id", "sk"),
            "Tags": tags("token-risk-accepted"),
        },
        {
            "TableName": f"{prefix}media-made", **common,
            "AttributeDefinitions": [S("user_id"), S("sk")],
            "KeySchema": keys("user_id", "sk"),
            "Tags": tags("media-made"),
        },
        {
            "TableName": f"{prefix}ledger-options", **common,
            "AttributeDefinitions": [S("pk"), S("sk")],
            "KeySchema": keys("pk", "sk"),
            "Tags": tags("ledger-options"), "_seed": "ledger_options",
        },
        {
            "TableName": f"{prefix}bugs-reported", **common,
            "AttributeDefinitions": [S(a) for a in ("pk", "sk", "list_pk", "list_sk", "status_pk", "user_id", "created_at")],
            "KeySchema": keys("pk", "sk"),
            "GlobalSecondaryIndexes": [
                gsi("bugs-by-month", "list_pk", "list_sk"),
                gsi("bugs-by-status", "status_pk", "list_sk"),
                gsi("by-user", "user_id", "created_at"),
            ],
            "Tags": tags("bug-reports"),
        },
        {
            "TableName": f"{prefix}reported-media", **common,
            "AttributeDefinitions": [S(a) for a in ("pk", "sk", "list_pk", "list_sk", "status_pk", "token", "owner_user_id", "created_at")],
            "KeySchema": keys("pk", "sk"),
            "GlobalSecondaryIndexes": [
                gsi("reports-by-month", "list_pk", "list_sk"),
                gsi("reports-by-status", "status_pk", "list_sk"),
                gsi("by-token", "token", "created_at"),
                gsi("by-owner", "owner_user_id", "created_at"),
            ],
            "Tags": tags("reported-media"),
        },
        {
            "TableName": f"{prefix}HeartbeatEtcEC2TypeServers", **common,
            "AttributeDefinitions": [S("server_id"), S("sk")],
            "KeySchema": keys("server_id", "sk"),
            "Tags": tags("heartbeat-servers"),
        },
        {
            "TableName": f"{prefix}Workhorses", **common,
            "AttributeDefinitions": [S("server_id"), S("sk")],
            "KeySchema": keys("server_id", "sk"),
            "Tags": tags("workhorses"),
        },
        {
            "TableName": f"{prefix}model-agreements", **common,
            "AttributeDefinitions": [S(a) for a in ("user_id", "sk", "model_id", "accepted_at")],
            "KeySchema": keys("user_id", "sk"),
            "GlobalSecondaryIndexes": [gsi("by-model", "model_id", "accepted_at")],
            "Tags": tags("model-agreements"),
        },
        {
            # notifications shown to every signed-in user (website and program); one partition, newest first
            "TableName": f"{prefix}user-broadcast", **common,
            "AttributeDefinitions": [S("pk"), S("sk")],
            "KeySchema": keys("pk", "sk"),
            "Tags": tags("user-broadcast"),
        },
        {
            "TableName": f"{prefix}models", **common,
            "AttributeDefinitions": [S(a) for a in ("model_id", "sk", "category", "cat_sk")],
            "KeySchema": keys("model_id", "sk"),
            "GlobalSecondaryIndexes": [gsi("models-by-category", "category", "cat_sk")],
            "Tags": tags("model-library"),
        },
    ]


def search_key(v):
    """Same as searchKey() in the website code: lower case, letters, digits and @._ - only."""
    import re
    import unicodedata
    return re.sub(r"[^a-z0-9@._ -]", "", unicodedata.normalize("NFKD", str(v or "").lower())).strip()


def index_attributes(item):
    """The index keys the website code writes, for items copied by --keep-users."""
    sk = item["sk"]
    if sk == "PROFILE":
        uid, t = item["user_id"], item.get("created_at", "")
        item["ulist_pk"], item["ulist_sk"] = "U#" + t[:7], f"{t}#{uid}"
        f, l = search_key(item.get("first_name")), search_key(item.get("last_name"))
        if f:
            item["fname_pk"], item["fname_sk"] = "FN#" + f[:2], f"{f} {l}".strip()
        if l:
            item["lname_pk"], item["lname_sk"] = "LN#" + l[:2], f"{l} {f}".strip()
        if item.get("IsAdmin") is True:
            item["admin_pk"] = "ADMIN"
        item["device_count"] = 0
        for k in ("last_seen", "last_state"):
            item.pop(k, None)
    elif sk == "EMAIL":
        email = item["pk"][len("EMAIL#"):]
        item["eml_pk"], item["eml_sk"] = "EM#" + email[:2], email
    return item


def recreate(ddb, region, prefix, names, keep_users):
    """Back up, delete and later recreate the named tables; returns the items to copy back."""
    import boto3
    keep = []
    if keep_users and "user" in names:
        t = boto3.resource("dynamodb", region_name=region).Table(prefix + "user")
        for uid in keep_users:
            items, kw = [], {}
            while True:                      # every item of the user: profile, addresses, sign-in sessions, ...
                r = t.query(IndexName="by-user", KeyConditionExpression="user_id = :u",
                            ExpressionAttributeValues={":u": uid}, **kw)
                items += r["Items"]
                if "LastEvaluatedKey" not in r:
                    break
                kw["ExclusiveStartKey"] = r["LastEvaluatedKey"]
            # the old index may project keys only: read the items themselves
            items = [t.get_item(Key={"pk": i["pk"], "sk": i["sk"]}).get("Item") for i in items]
            items = [i for i in items if i and (i["sk"] in ("PROFILE", "EMAIL", "SESSION") or i["sk"].startswith("EMAIL#"))]
            if not any(i["sk"] == "PROFILE" for i in items):
                sys.exit(f"--keep-users: no user {uid}")
            emails = [i["email"] for i in items if i["sk"].startswith("EMAIL#")]
            for i in items:
                if i["sk"] == "PROFILE":
                    i["email_count"] = len(emails)
            keep += [index_attributes(dict(i)) for i in items]
            print(f"keep     user {uid}: {len(items)} items")
    stamp = time.strftime("%Y%m%d-%H%M%S")
    for n in names:
        name = prefix + n
        try:
            ddb.describe_table(TableName=name)
        except ddb.exceptions.ResourceNotFoundException:
            continue
        b = ddb.create_backup(TableName=name, BackupName=f"{name}-before-recreate-{stamp}")["BackupDetails"]
        print(f"backup   {name}: {b['BackupName']} ({b['BackupStatus']})")
        ddb.update_table(TableName=name, DeletionProtectionEnabled=False)
        ddb.get_waiter("table_exists").wait(TableName=name)
        ddb.delete_table(TableName=name)
        ddb.get_waiter("table_not_exists").wait(TableName=name, WaiterConfig={"Delay": 5, "MaxAttempts": 60})
        print(f"deleted  {name}")
    return keep


def seed_credit_rules(name, region):
    """Write the first rule and its audit entry, only if the table has no rules yet."""
    import datetime
    import json
    import secrets
    from decimal import Decimal
    import boto3
    t = boto3.resource("dynamodb", region_name=region).Table(name)
    if t.query(KeyConditionExpression="pk = :r", ExpressionAttributeValues={":r": "RULE"}, Limit=1)["Items"]:
        return "rules already present; " + seed_ratings(t)
    now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    rid, aid = secrets.token_hex(6), secrets.token_hex(6)
    rule = {"pk": "RULE", "sk": f"{SEED_RULE['effective_from']}#{rid}", "rule_id": rid,
            "effective_from": SEED_RULE["effective_from"], "credit_per_wu": Decimal(SEED_RULE["credit_per_wu"]),
            "first_finisher_share": Decimal(SEED_RULE["first_finisher_share"]), "note": SEED_RULE["note"],
            "status": "active", "created_by": "CreateTables.py", "created_by_email": "", "created_at": now}
    t.put_item(Item=rule, ConditionExpression="attribute_not_exists(pk)")
    t.put_item(Item={"pk": "AUDIT", "sk": f"{now}#{aid}", "action": "seed", "rule_id": rid, "by": "CreateTables.py",
                     "by_email": "", "at": now, "before": "", "after": json.dumps(SEED_RULE)})
    msg = f"seeded rule {rid}: {SEED_RULE['credit_per_wu']} credit per WU from {SEED_RULE['effective_from']}"
    return msg + "; " + seed_ratings(t)


# The first coin of the pool: PlanetComp (Solana mainnet, Token-2022, 6 decimals, 1 B fixed, mint authority revoked);
# on devnet the test coin stands in for it.
SEED_COIN = {"coin_id": "planetcomp", "name": "PlanetComp", "symbol": "PlanetComp",
             "mint_mainnet": os.environ.get("PCC_MINT_MAINNET", ""),   # the production mint (set PCC_MINT_MAINNET; not in the repo)
             "decimals": 6, "token_program": "token-2022",
             "address_from": "",                                       # the owner fills in the mainnet sending wallet
             "mint_devnet": "7vSuZp6HJ7pi23gUHbrbtLJWVtjfH43chMhtHeiQpm2z", "decimals_devnet": 9,
             "address_from_devnet": "EFAkhAkLaGSoE1ThuQT7RP2Lw3vCYiHdvNxcJJpkBjG2",   # the devnet treasury
             "note": "The first coin: 1 B fixed supply, mint authority revoked."}


def seed_ledger_options(name, region):
    """Write PlanetComp (active) and a share set of 100 % PlanetComp from now, only if the table has no coins yet."""
    import datetime
    import json
    import secrets
    import boto3
    t = boto3.resource("dynamodb", region_name=region).Table(name)
    if t.query(KeyConditionExpression="pk = :c", ExpressionAttributeValues={":c": "COIN"}, Limit=1)["Items"]:
        return "coins already present"
    now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    sid = secrets.token_hex(6)
    shares = [{"coin_id": SEED_COIN["coin_id"], "pct": 100}]
    t.put_item(Item={"pk": "COIN", "sk": SEED_COIN["coin_id"], **SEED_COIN, "status": "active", "created_by": "CreateTables.py",
                     "created_at": now, "updated_at": now}, ConditionExpression="attribute_not_exists(pk)")
    t.put_item(Item={"pk": "SET", "sk": f"{now}#{sid}", "set_id": sid, "effective_from": now, "shares": json.dumps(shares),
                     "note": "PlanetComp 100 %", "status": "active", "created_by": "CreateTables.py", "created_by_email": "",
                     "created_at": now}, ConditionExpression="attribute_not_exists(pk)")
    for action, after in (("seed_coin", SEED_COIN), ("seed_set", {"set_id": sid, "effective_from": now, "shares": shares})):
        t.put_item(Item={"pk": "AUDIT", "sk": f"{now}#{secrets.token_hex(6)}", "action": action, "by": "CreateTables.py",
                         "by_email": "", "at": now, "before": "", "after": json.dumps(after)})
    return f"seeded PlanetComp (active) and share set {sid}: PlanetComp 100 % from {now}"


# First machine-rating set (bands in WU per second; see the design document, 11.8c).
SEED_RATING = {"effective_from": "2026-10-01T00:00:00Z",
               "bands": [0.000001, 0.000002, 0.000005, 0.00001, 0.00002, 0.00005, 0.0001, 0.0002, 0.0005, 0.001,
                         0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 4],
               "standby_fraction": "0.1", "police_interval_s": 60, "challenge_ms": 1000, "max_standby_devices": 5,
               "note": "Initial machine ratings: bands from 1e-6 to 4 WU/s, standby one tenth, capacity test every minute."}


def seed_ratings(t):
    import datetime, json, secrets
    from decimal import Decimal
    if t.query(KeyConditionExpression="pk = :r", ExpressionAttributeValues={":r": "RATING"}, Limit=1)["Items"]:
        return "ratings already present"
    now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    rid, aid = secrets.token_hex(6), secrets.token_hex(6)
    t.put_item(Item={"pk": "RATING", "sk": f"{SEED_RATING['effective_from']}#{rid}", "rule_id": rid,
                     "effective_from": SEED_RATING["effective_from"], "bands": json.dumps(SEED_RATING["bands"]),
                     "standby_fraction": Decimal(SEED_RATING["standby_fraction"]), "police_interval_s": SEED_RATING["police_interval_s"],
                     "challenge_ms": SEED_RATING["challenge_ms"], "max_standby_devices": SEED_RATING["max_standby_devices"],
                     "note": SEED_RATING["note"], "status": "active", "created_by": "CreateTables.py", "created_by_email": "",
                     "created_at": now}, ConditionExpression="attribute_not_exists(pk)")
    t.put_item(Item={"pk": "AUDIT", "sk": f"{now}#{aid}", "action": "seed_rating", "rule_id": rid, "by": "CreateTables.py",
                     "by_email": "", "at": now, "before": "", "after": json.dumps(SEED_RATING)})
    return f"seeded rating set {rid}"


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--dry-run", action="store_true", help="print definitions, create nothing")
    ap.add_argument("--recreate", default="", help="comma-separated table names without the prefix to back up, delete "
                                                   "and create again (their data is lost), e.g. user,user-credits")
    ap.add_argument("--keep-users", default="", help="with --recreate including user: comma-separated user IDs to copy over")
    args = ap.parse_args()

    load_dotenv()
    prefix = os.environ.get("DYNAMODB_TABLE_PREFIX", "planetcompute-ai-")
    defs = table_definitions(prefix)
    if args.dry_run:
        import json
        print(json.dumps([{k: v for k, v in d.items() if not k.startswith("_")} for d in defs], indent=2))
        return

    import boto3
    from botocore.exceptions import ClientError

    region = os.environ.get("AWS_REGION", "us-east-1")
    ddb = boto3.client("dynamodb", region_name=region)       # credentials from the environment
    keep = []
    if args.recreate:
        names = [n.strip() for n in args.recreate.split(",") if n.strip()]
        known = {d["TableName"][len(prefix):] for d in defs}
        if set(names) - known:
            sys.exit(f"--recreate: unknown tables {sorted(set(names) - known)}; known: {sorted(known)}")
        keep = recreate(ddb, region, prefix, names, [u.strip().lower() for u in args.keep_users.split(",") if u.strip()])
    existing = set()
    for page in ddb.get_paginator("list_tables").paginate():
        existing.update(page["TableNames"])

    for d in defs:
        name = d["TableName"]
        if name in existing:
            print(f"exists   {name}")
        else:
            try:
                ddb.create_table(**{k: v for k, v in d.items() if not k.startswith("_")})
                print(f"creating {name} ...")
                ddb.get_waiter("table_exists").wait(TableName=name, WaiterConfig={"Delay": 5, "MaxAttempts": 60})
            except ClientError as e:
                sys.exit(f"failed   {name}: {e}")
        for attempt in range(30):            # a brand-new table refuses this for a minute or so
            try:
                ddb.update_continuous_backups(TableName=name,
                                              PointInTimeRecoverySpecification={"PointInTimeRecoveryEnabled": True})
                break
            except ClientError as e:
                if e.response["Error"]["Code"] != "ContinuousBackupsUnavailableException" or attempt == 29:
                    raise
                time.sleep(10)
        if d.get("_seed") == "credit_rules":
            print(f"seed     {name}: {seed_credit_rules(name, region)}")
        if d.get("_seed") == "ledger_options":
            print(f"seed     {name}: {seed_ledger_options(name, region)}")
        if d.get("_ttl"):
            ttl = ddb.describe_time_to_live(TableName=name)["TimeToLiveDescription"]
            if ttl.get("TimeToLiveStatus") not in ("ENABLED", "ENABLING"):
                ddb.update_time_to_live(TableName=name, TimeToLiveSpecification={"Enabled": True, "AttributeName": d["_ttl"]})
        t = ddb.describe_table(TableName=name)["Table"]
        idx = ", ".join(f"{g['IndexName']} ({g['IndexStatus']})" for g in t.get("GlobalSecondaryIndexes", []))
        ttl_note = f"; expiry on '{d['_ttl']}'" if d.get("_ttl") else ""
        print(f"ready    {name}: {t['TableStatus']}; indexes: {idx}; point-in-time recovery on{ttl_note}")
    if keep:
        t = boto3.resource("dynamodb", region_name=region).Table(prefix + "user")
        users = 0
        with t.batch_writer() as w:
            for item in keep:
                w.put_item(Item=item)
                users += item["sk"] == "PROFILE"
        t.update_item(Key={"pk": "STATS", "sk": "COUNTS"}, UpdateExpression="ADD #u :n", ExpressionAttributeNames={"#u": "users"},
                      ExpressionAttributeValues={":n": users})
        print(f"copied   {len(keep)} items of {users} kept users into {prefix}user")


if __name__ == "__main__":
    main()
