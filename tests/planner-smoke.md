# Planner smoke-test cases

These are manual test definitions, not an automated runner. Keep this file out
of the sample-project orb and out of the model's prompt.

Use a fresh orb for each run, with Claude Code mode, `claude-opus-5-5`, and high
effort. The sample project must include the plugin checkout and its setup link.
Record both repository commits and confirm the skill and planner were actually
invoked; a returned plan from an unrelated agent does not exercise this test.

Use this exact initial prompt for both cases, without plugin hints or expected
findings:

> Upgrade the concurrent-ruby gem to 1.3.8

Capture the raw subagent handoff and response as well as the final response.
If the parent supplies an expected finding to the planner, do not count that
finding as independent planner discovery. Do not require a particular report
format.

## Target outside the exact pin

**Fixture:** the unmodified sample application, Rails 7.0.8.7, installed and locked
concurrent-ruby 1.3.4, and `gem "concurrent-ruby", "1.3.4"` in the Gemfile.
The published target 1.3.8 does not satisfy this exact requirement.

**Expected result:** the planner returns an application-specific plan identifying
affected code, recommended changes, and validation steps. It identifies the
incompatible pin and proposes changing it to 1.3.8. It accounts for the Rails 7.0
logger boot issue and proposes explicit logger loading before Rails loads, with
boot and application-test checks. The working application files remain unchanged.

**Fail if:** the agent stops to request permission to edit the Gemfile instead of
returning a complete plan, treats an excluded target as an unavailable release,
or implements the upgrade. A correct pin change alone does not establish a
complete compatibility plan.

## Target inside the requirement: control

**Fixture:** a disposable variant of the same application with
`gem "concurrent-ruby", "~> 1.3.0"`. Prepare a matching lockfile before the run,
retaining installed and locked version 1.3.4 and all other gem versions. Record
the prepared fixture state; do not change the frozen sample baseline.
The target 1.3.8 satisfies this requirement.

**Expected result:** the planner returns the compatibility plan without claiming
that the Gemfile version requirement must change. The logger issue still applies,
and the plan includes the lockfile update and validation. Application files
remain unchanged relative to the prepared fixture state.

**Fail if:** the planner unnecessarily requires a Gemfile requirement change,
omits the compatibility work because the target is allowed, stops at an approval
request instead of returning a plan, or implements the upgrade.

## Record results without overstating them

For each case, report plan delivery, requirement handling, compatibility findings,
and application-file preservation separately. Distinguish observed tool results
from experiments described only in the planner's report. An empty system-test
suite is not browser coverage.

See the [README](../README.md#five-fresh-orbs-delegated-planning-without-implementing)
for run records. One old/new run per case would require four sessions; that
comparison is not a reliability estimate.
