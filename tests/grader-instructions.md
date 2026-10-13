# Grading an upgrade plan against the answer key

You grade one gem-upgrade plan written for the Margin Notes Rails application.
The plan is the text the user received. The answer key below lists the selected
findings for this upgrade. Grade each finding in the key against the plan.

Grade only what the plan text says. Do not credit content from an earlier report,
a diff or an experiment log unless the plan itself states it. Do not credit a
finding because it would be easy to infer. When a plan is a short summary that
drops details, grade the summary.

For each finding, give four independent judgments. Each is `supported`, `partial`,
`missing` or `incorrect`.

**Application impact.** Supported when the plan states a concrete consequence for
this application on the target version: for example, this model no longer loads,
this call raises, this job no longer retries the same way, duplicates are
enqueued, a page silently changes size. The plan does not need to list every
downstream consequence in the key. Partial when the plan only names a removed or
deprecated API, an error class or a changelog entry without saying what in this
application breaks or changes, or when it states a different consequence than
the key's. Missing when the plan does not discuss the finding.

**Correct applicability.** Supported when the plan names the affected code and the
correct conditions. Conditions include which version introduces the change,
whether it depends on adopting a new framework default (the fixture keeps
`load_defaults 7.0`), whether it only appears during a mixed-version rollout, and
whether a preparatory change also works on the current version. Stating a wrong
condition is incorrect: for example, calling a defaults-dependent change an
unconditional failure, or calling a target-only syntax a safe advance patch.

**Valid recommendation.** Supported when the plan recommends the key's repair or
an equivalent one that preserves the application's public behavior. Judge the
repair for this finding only: omitting a prerequisite that the key lists as a
separate observation, or not restating that unaffected behavior stays the same,
does not make it partial. Partial when the repair as written does not fully fix
this finding, or when the plan offers an unsafe alternative on equal footing with
a safe one. Incorrect when the recommended repair is invalid or would break
existing behavior. Missing when there is no repair for this finding.

**Discriminating validation.** Supported only when the plan specifies the key's
complete discriminating scenario and controls, whether as executed checks or as
checks to run. Partial when the plan gives some relevant checks, such as a test
suite result, named tests or a subset of the scenario. Missing when the plan gives
no validation for this finding. Proposed checks are plan content; they are not
evidence that anything passed.

A finding the plan never mentions gets `missing` for all four judgments. Extra
findings outside the key do not change these grades. Do not reward length or the
number of issues listed.

For each finding, quote the shortest plan text that supports your judgments, or
leave the quote empty when nothing is relevant. Give a one-sentence reason for
every judgment that is not `supported`.
