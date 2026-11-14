# Change requests

A change request is one change a client asks for after the site is live. The hub stores it in `change-requests.json` and counts it, when it is accepted, against the plan's changes for that Europe/Oslo month.

The routes stay closed until `changeRequests.enabled` is on and `changeRequests.paused` is null. While the switch is off every change-request route answers `404 {code:'disabled'}` and writes nothing.

## Intake

`POST /api/hub/change-requests` takes `type`, `title`, `description`, `pageUrl`, `elementRef`, `attachments` and `priority`. A valid site credential (`x-site-credential` with `x-site-key`) is verified. The public site key alone is not: at most 20 such requests per site per Oslo day, and the 21st answers `429 {code:'rate-limited'}`. An invalid or revoked credential answers 401. A body over 16384 bytes answers `413 {code:'too-large'}`.

`GET /api/hub/change-requests` with the credential returns the list (newest first, at most 50) and the quota. With the site key alone it returns the quota and an empty list (`itemsHidden: true`).

## Quota and the due date

A request counts at acceptance (`countedAt`, `month`). Requests that are only received, and requests accepted before go-live, do not count. The default is track: past the month's `changesPerMonth` the request still proceeds with `overQuota: true`. Block is a per-plan setting and answers `409 {code:'over-quota'}` with nothing written. `serviceTerms.unlimited` lifts the cap through its `until` date.

`dueAt` is `changeRequests.slaWorkDays` work days after the acceptance (the date only). A request that is not done and is past that date is flagged `overdue` when it is read. `agentQuotaUnits` is stored beside `quotaUnits`; a difference is flagged and the counted units are not changed.

## Staff

`GET /api/admin/change-requests`, `PATCH /api/admin/change-requests/:id` and `POST /api/admin/sales/:id/change-requests` need an admin or a developer. A sales-only role answers 403. No credentials answers 401. Status moves `received → accepted → in-progress → done`, or to `rejected` from `received` or `accepted`. Anything else answers `409 {code:'invalid-transition'}`.

Starting a verified request enqueues one `change_request` job. An unverified request never does.

A cancelled or paused contract answers 409 with the delivery lifecycle's code and message (`Avtalen er avsluttet` when the contract has ended).
