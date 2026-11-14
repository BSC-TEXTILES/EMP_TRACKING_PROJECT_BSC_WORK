# Ticket workflow
Existing actions: assign, acknowledge, start, wait for information, resolve, close, reopen, escalate, cancel and rate. Requesters can reopen resolved/closed tickets. Reassignment is available through the assignment control. Assignment targets must be active with effective ticket-resolution permission. Ticket actions now check record visibility before mutation.

State transitions use a conditional update against the previously read status; response/resolution/closure timestamps are updated with that transition. Illegal transitions do not write resolution timestamps. Comments and assignment history persist. Internal notes are hidden from ordinary requesters.

Remaining: investigating, waiting for third party and explicit escalated states; atomic assignment history; complete status timeline; resolution-confirmation policy; routing by department/location/module/SLA and workload concurrency.
