# SEO job gating

`seo.jobGating` chooses who decides automatic posts and Maps ranking. The modes, the blog rule and the Maps rule are in [SEO record, job gating and the DataForSEO ledger](seo-record.md).

## Modes

- Off (`enabled: false`, the default): the old gates decide.
- Shadow: the old gates decide, and each site where the feature-key gate would differ is logged.
- Auto: the feature-key gate decides. Auto is release-gated. `recordReleasePass('seo.jobGating', { suite, evidence })` must record a pass whose `evidence` is non-empty and names the reviewed output of `node scripts/seo-gating-diff.mjs --data <copy>`. A pass with empty evidence does not count. Shadow and off need no pass.

## Blog module

Automatic posts (`blog-scheduler`) also need the site's blog module (`features.blog`). A site with the blog off gets none, on every tier.

## Maps refresh

In auto, a paid Maps refresh (the hourly loop, a dashboard refresh, and the portal's refresh button) makes no DataForSEO call when `seo.tracking.maps` is off. Off and shadow leave those paths unchanged.
