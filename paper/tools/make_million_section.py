#!/usr/bin/env python3
"""Paper: new section on the million-device simulation (what it is, what is real, what it accomplishes), numbers
from gridSim/results/pull-1M.json (after the 15.7 fixes) and results/before-15.7abc/pull-1M.json. Run in paper/."""
import json

R = "../gridSim/results/"
mid = json.load(open(R + "pull-1M.json"))
new = json.load(open(R + "pull-1M-dir25.json"))
old = json.load(open(R + "before-15.7abc/pull-1M.json"))


def online(o):
    return sum(l["devices"] for l in o["lanes"])


def iq(o):
    return max(l["idleWhileQueued"] for l in o["lanes"]) * 100


def n(x):
    return f"{round(x):,}".replace(",", "{,}")


def g(o, *k):
    for a in k:
        o = o.get(a) if isinstance(o, dict) else None
        if o is None:
            return None
    return o


def row(label, f, fmt=n):
    show = lambda v: "--" if v is None else fmt(v)
    return f"{label} & {show(f(old))} & {show(f(mid))} & {show(f(new))} \\\\\n"


pct1 = lambda v: f"{v:.1f}\\%"
pct2 = lambda v: f"{v:.2f}\\%"
sec = lambda v: f"{v:.0f}~s"
refused = lambda o: sum(o["jobs"]["rejected"].values())

rows = "".join([
    row("Devices in the run (online on average)", lambda o: o["population"]),
    row("\\quad online on average", online),
    row("Jobs submitted", lambda o: o["jobs"]["submitted"]),
    row("Jobs finished within the hour", lambda o: o["jobs"]["finished"]),
    row("Jobs refused at admission", refused),
    row("Jobs stalled ($>600$~s without progress)", lambda o: o["jobs"]["stalled"]),
    row("Idle while queued, worst lane", iq, pct2),
    row("Small jobs: time to finish, median", lambda o: o["timesSeconds"]["small"]["p50"], sec),
    row("Small jobs: time to finish, 99th pct.", lambda o: o["timesSeconds"]["small"]["p99"], sec),
    row("Large jobs: time to finish, 99th pct.", lambda o: o["timesSeconds"]["large"]["p99"], sec),
    row("First result to the consumer, 99th pct.", lambda o: o["timeToFirstResult"]["p99"], sec),
    row("WorkPacks computed (simulated)", lambda o: o["devices"]["packsRun"]),
    row("Cheating answers caught", lambda o: o["jobs"]["cheatersCaught"]),
    row("Wrong answers delivered and never corrected", lambda o: g(o, "jobs", "wrongDeliveredUncorrected") if "wrongDeliveredUncorrected" in o["jobs"] else o["jobs"]["wrongAccepted"]),
    row("Extra copies (quorum, audits, hedges)", lambda o: o["jobs"]["extraCopiesShare"] * 100, pct1),
    row("Copies stopped once their pack was accepted", lambda o: g(o, "jobs", "copiesStopped")),
    row("Copies that still finished late", lambda o: g(o, "jobs", "lateCopies")),
    row("Model downloads", lambda o: o["devices"]["modelDownloads"]),
    row("Busiest lane shard / directory (share of time busy)",
        lambda o: (o["peaks"]["shard"]["util"] * 100, o["peaks"]["dir"]["util"] * 100),
        lambda v: f"{v[0]:.0f}\\% / {v[1]:.0f}\\%"),
    row("Lane directories", lambda o: o["peaks"]["dir"]["count"]),
    row("Busiest directory: peak messages per second", lambda o: o["peaks"]["dir"]["rate"]),
    row("Device messages per second", lambda o: o["perSecond"]["wsIn"]),
    row("Requests between objects per second", lambda o: o["perSecond"]["doRequests"]),
    row("Ledger writes per second", lambda o: o["perSecond"]["ledgerWrites"]),
    row("Time to simulate the hour on one server", lambda o: o["wallSeconds"] / 60, lambda v: f"{v:.0f}~min"),
])
rows = rows.replace("Devices in the run (online on average)", "Devices in the run (all who came and went)")

J = new["jobs"]
section = r'''\section{The Million-Device Run: What It Is and What It Accomplishes}\label{sec:million}

Section~\ref{sec:orchsim} described the simulator; this section says plainly what the run at one million
devices is, what in it is real and what is not, and what it is for.

\subsection{What Runs, and What Is Simulated}

The run is a simulation on \emph{one} ordinary server (two processor cores, 8~GB of memory). No AI image or
text is generated in it, no real computer volunteers, and no network is crossed. Three things are simulated:
\begin{itemize}
  \item \textbf{The volunteers:} about a million devices that come and go over the hour (sessions with a
        median of 40 minutes, about 10 minutes away), each a small record in memory: 70\% browser CPUs, 25\%
        browser GPUs, 4\% 12-GB and 1\% 24-GB graphics cards, with speeds that vary by a factor of
        several. 2\% of them cheat, answering 70\% of their WorkPacks wrongly, and 0.2\% take a WorkPack and
        never answer.
  \item \textbf{The customers:} $10^4$ consumers who submit jobs at random through the hour, from a few
        seconds of work to the equivalent of $2\times10^6$ device-seconds.
  \item \textbf{The work:} jobs in five lanes, each a model and a kind of machine: CPU WebAssembly, text
        embeddings on browser GPUs, an 8-B language model and SDXL image generation on 12-GB GPUs, and a
        14-B language model on 24-GB GPUs. Every job is cut into WorkPacks; a WorkPack is not computed but
        \emph{takes time}, according to the device's speed, and returns either the correct answer or, from a
        cheater, a wrong one.
\end{itemize}

What is real is the \textbf{orchestrator}: the lane shards, lane directories, planner, intake and job
coordinators of Section~\ref{sec:orchsim}, as the same code that will run on Cloudflare as Durable Objects.
Each is written to act only through messages, so the simulator can run them unchanged and charge each one
for the time its messages take. Neither the browser console nor the \texttt{planetCompute} program
(Section~\ref{sec:client}) takes part: the endpoints through which they will receive WorkPacks from the
orchestrator do not exist yet.

\subsection{How Work Is Sent and Checked}

The same rules as the deployed system will use:
\begin{itemize}
  \item A device that has no record yet is never trusted alone: its WorkPack is sent to devices on
        \textbf{three different networks}, and the answer is accepted when three answers agree.
  \item A device with a record is trusted alone, but a share of its WorkPacks is \textbf{audited} by a
        second device: often just after it earns trust, never less than 5\%.
  \item When a job's last WorkPacks run late, extra \textbf{hedge} copies race them, and as soon as a
        WorkPack is accepted its other copies are cancelled.
  \item A device caught giving a wrong answer is banned, and every WorkPack it delivered recently is run
        again, also after delivery, with the consumer told which results changed.
\end{itemize}
The first correct finisher of a raced WorkPack is the one whose answer is used; the credit rules of
Section~\ref{sec:race} then reward it most.

\subsection{What the Run Accomplishes}

Each question below is one that would be expensive to answer after deployment and cheap to answer here:
\begin{enumerate}
  \item \textbf{Does work reach idle devices at this scale?} A grid ``locks'' when WorkPacks wait in one
        place while devices that could run them wait in another. Measured as idle-while-queued time.
  \item \textbf{Is any single object a bottleneck?} A Durable Object is single-threaded; one that receives
        too many messages builds a queue that slows everything behind it.
  \item \textbf{Are wrong answers kept from customers}, including from devices that behave well until they
        are trusted?
  \item \textbf{How much redundancy does checking cost}, and how much volunteer work is wasted on copies
        that are no longer needed?
  \item \textbf{How many messages and storage writes per second} will the real system need, which decides
        whether it is affordable to run?
\end{enumerate}
It also finds faults: the first runs found the seven of Section~\ref{sec:orchsim} and the four fixed since.

\subsection{Results at One Million Devices}

Table~\ref{tab:million} compares three runs at one million devices: the first run, the run after the fixes of
Section~\ref{sec:orchsim} (stricter auditing of newly trusted devices, re-running a caught cheater's past
WorkPacks, faster admission and cancelling unneeded copies), and the same with each lane directory serving 25
lane shards instead of 50. All three use the same seed, so the devices and
jobs are the same; sleeper cheaters are tested separately at $10^5$ devices.

\begin{table}[ht]
\centering
\caption{One simulated hour with about a million volunteer devices and $10^4$ consumers, pull policy, demand at
half of capacity: the first run, after the fixes, and after the fixes with directories split further.}\label{tab:million}
\footnotesize
\begin{tabularx}{\linewidth}{@{}Xrrr@{}}
\toprule
 & \textbf{First run} & \textbf{Fixes} & \textbf{Fixes and} \\
 & & & \textbf{25 shards/dir.} \\
\midrule
''' + rows + r'''\bottomrule
\end{tabularx}
\end{table}

''' + "%%RESULTS%%" + r'''

\subsection{What It Does Not Show}

A simulation can only be as right as its assumptions. It does not measure the real latency of Cloudflare's
network or Durable Objects, real model speeds, real downloads, or the behaviour of real browsers and of the
\texttt{planetCompute} program; device behaviour and cheating are modelled, not observed.

\subsection{From Simulation to a Real Test}

The load of the grid lives in the orchestrator, the Worker and the database: each real computer only does its
own work. Scale is therefore proven with \emph{simulated} clients against the \emph{real} orchestrator, and the
real programs are tested for \emph{variety}, on many kinds of machine, rather than for volume. Every step is
automated, so that testing does not depend on anyone's spare time. Four steps follow from this:
\begin{enumerate}
  \item \textbf{The simulation} of this section, on one server: the orchestrator's code, with simulated devices,
        consumers and work. It costs nothing and is where design faults are cheapest to find; besides the faults
        of Section~\ref{sec:orchsim}, it showed the busiest lane directory peaking at about 820 messages a
        second with 50 shards per directory, close to the request rate a single Durable Object is advised to
        take, so directories now serve 25 shards each.
  \item \textbf{Real Durable Objects, simulated clients.} The same classes run as Durable Objects on a staging
        Worker, behind the endpoints through which devices take WorkPacks and the Harness submits jobs.
        \begin{itemize}
          \item \emph{Up to a million devices, generated inside Cloudflare.} Simulated devices and Harness users
                run as objects in the same staging account and talk to the real orchestrator, rising from $10^4$
                to $10^5$ and $10^6$ and stopping at the first failure. This measures what the simulation could
                only assume: the request rate one Durable Object really sustains, platform limits, the write
                rate of the database and the real cost. Simulated devices carry test-only network labels so that
                the three-network quorum is exercised.
          \item \emph{A small test of real connections.} The generators do not cross the internet, so they skip
                the connection layer: WebSocket upgrades, idle connections that hibernate, memory per connection.
                Because lane shards are independent, each holding about a thousand devices and never talking to
                another shard, it is enough to show that one shard, and several side by side, serve a thousand
                real connections each: some $5{,}000$ to $20{,}000$ WebSockets opened by the
                \texttt{planetCompute} program's load mode from one or two machines.
        \end{itemize}
  \item \textbf{Real programs on varied machines, automatically.} The build pipeline already runs a real model
        on Windows, macOS (Apple Silicon) and Linux; it will also join the staging grid as a contributor and
        submit a Harness job. Browser automation drives the real volunteer page in Chromium, Firefox and WebKit.
        Rented servers with four to six kinds of NVIDIA GPU, and one AMD GPU, run \texttt{planetCompute
        --headless} for about an hour each. The main question is whether real answers from the same model
        \emph{agree} across different hardware, since quorum and audits depend on agreement
        (Section~\ref{sec:race}). Sleep, wake and lost connections are produced by the test scripts, by cutting
        and restoring the network or pausing the program.
  \item \textbf{A soft launch.} The grid is switched on for a small group first and widened step by step,
        watched through the administration pages of Section~\ref{sec:admin}: contributors, capacity checks
        and bug reports. The full variety of real machines can only come from real users.
\end{enumerate}

A load test from outside would face a problem the system itself does not have. Real use brings a million
devices from roughly a million home addresses, arriving over time, which is ordinary traffic; a million
simulated devices from a few dozen servers, some $25{,}000$ connections per address, is what an automated
attack looks like, and the firewall would be measured instead of the orchestrator. Generating the load inside
Cloudflare avoids this, and the small connection test stays within normal limits. Two lessons of the same
reasoning do apply in production. After an update, clients must reconnect after a random delay: without it,
$10^5$ simulated devices reconnected at about $9\times10^4$ connections a second (about $9\times10^5$ scaled to
a million), which a real attack filter could reasonably block, while 30~seconds of jitter brought the peak to
about $3\times10^3$ a second. And many real users share one address (universities, offices and mobile
networks), so limits per address stay generous for signed-in devices and limits per account do the real work.

The million-device simulation is what makes the later steps worth their cost: they are run only once the
design has stopped failing on one server.

'''
p = "planetcompute.tex"
s = open(p).read()
anchor = r"\section{Threat Model}\label{sec:threat}"
assert s.count(anchor) == 1 and r"\label{sec:million}" not in s   # \ref{sec:million} is already used earlier
s = s.replace(anchor, section + anchor)
open(p, "w").write(s)
print("section inserted; fill %%RESULTS%%")
print(rows)
