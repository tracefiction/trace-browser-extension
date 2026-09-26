# Reading activity transport

Reading writes carry a stable operation identity and local calendar context.
This transport does not enable recording or change permissions, origins, host
ownership, or session policy.

The kernel owns a fresh command object for each execute. Runtime adapters retain a
UUID, original occurrence timestamp, numeric timezone offset, and matching local
calendar date across authentication retries. Track and progress patches use that
context. Resolved finish qualification preserves its existing operation UUID and
adds the original calendar. Open finish prompts remain non-reading signals.
The legacy background paths retain the same serialized context during retry.
There is no durable retry queue across worker or account lifetimes; existing
uncertain-result reconciliation is retained.

Recording activation requires compatible API support and verification of every
client that writes reading activity.
