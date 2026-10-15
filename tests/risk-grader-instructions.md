# Grading a risk report against the expected risk labels

You grade one gem-upgrade risk report written for the Margin Notes Rails
application. The report is the text the developer received. It lists the changes
between two versions of a gem that affect the application and rates each one high,
medium or low risk. Below these instructions, the labels list the planted changes
and the risk a good report gives each one. The answer key after the labels
describes each change and the code it affects in more detail. Use the answer key
to check facts, not as a list of things the report must say.

The report's levels mean:

- High: behavior changes without an error in an area the application uses, or the
  change affects stored data or queued jobs while old and new versions run side by
  side.
- Medium: the application raises an error, but the fix needs a decision.
- Low: a mechanical change with a direct replacement that booting or the tests
  would catch.

Grade only what the report says. Don't credit a change because it would be easy to
infer from something else in the report.

For each labeled change, give three independent judgments.

**Found.** `located` when the report describes the change and names the
application code it affects, by file. A line number isn't needed. `named` when the
report describes the change but doesn't tie it to the affected code, or ties it to
the wrong code. `missing` when the report doesn't discuss the change.

**Level.** Record the level the report gives the change, not the level you think is
right: `high`, `medium`, `low`, `not_relevant` when the report says the change
doesn't affect the application, `unrated` when the report discusses it without a
level, or `missing`. When the report rates by section, use the section the change
appears in. When the change appears in more than one place, use the entry that
explains it most fully. For a change that applies only if the application adopts a
new framework default, record the level the report gives to adopting it.

**Accuracy.** `inaccurate` when any claim the report makes about the change
contradicts the answer key. For example, the report says a call raises when it
returns a different value without an error, says a new default applies while the
application keeps `load_defaults 7.0`, or says a mixed-version failure also
happens when every process runs the new version. A level you disagree with isn't
inaccurate by itself, and neither is a consequence the report leaves out.
`accurate` otherwise, and `missing` when Found is `missing`.

For each change, quote the shortest report text that supports your judgments, or
leave the quote empty when the report doesn't discuss it. Give a one-sentence
reason when Found isn't `located`, when Accuracy is `inaccurate`, or when the level
differs from the label.

Then list two things outside the labels, without judging them:

- Other gems: each gem the report says the upgrade moves to a new version, other
  than the gems released together with the requested gem. Quote the report.
- Other findings: each change the report rates high or medium that isn't one of the
  labeled changes, in one short sentence with its level.
