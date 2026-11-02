# india-compliance

[resilient-tech/india-compliance](https://github.com/resilient-tech/india-compliance) at `89aa1d40`. 759 files in 14 groups, 5 rules.

Where it came from:
- `AGENTS.md`: extend ERPNext, never fork it; find every caller and fix the shared place once
- `.claude/skills/ic-feature-creation/SKILL.md`: the patches.txt bump, `doctype_js` load order, server-side guards, workflow tests
- `.github/POSTGRES_COMPATIBILITY.md`: MariaDB output never changes; PostgreSQL is brought in line
- checks: `bench run-tests` for the test modules next to each area, from `.github/workflows/server-tests.yml`

## Before editing a custom field

```markdown
# Read first: `india_compliance/gst_india/constants/custom_fields.py`

## Rules that must keep holding

- **bump-field-patch**: a new or changed custom field or property setter bumps the numbered create_custom_fields / create_property_setters line in patches.txt — why: existing sites never receive the field otherwise (ic-feature-creation/SKILL.md:31)

## Watch out

- field names and code lists are read from these constant classes everywhere; a raw string key elsewhere is a house-rule violation (ic-feature-creation/SKILL.md:19) _(group fields-and-setters)_

## Run these checks

- `bench --site test_site run-tests --app india_compliance --module india_compliance.tests.test_patches` — every patch runs on a fresh site
```

## Before editing hooks.py

```markdown
# Read first: `india_compliance/hooks.py`

## Rules that must keep holding

- **extend-dont-fork**: ERPNext or Frappe behaviour changes through a doc_events / override_* entry in hooks.py pointing at gst_india/overrides/; never edit another app — why: the app extends ERPNext and never forks it (AGENTS.md:3, ic-feature-creation/SKILL.md:21)

## Watch out

- doctype_js list order is load order: a script that calls setup_e_waybill_actions must come after e_waybill_actions.js, or the form dies with a ReferenceError and registers no handlers (.claude/skills/ic-feature-creation/SKILL.md:43) _(group wiring)_

## Run these checks

- `bench --site test_site run-tests --app india_compliance --module india_compliance.tests.test_patches` — install and patch wiring
```
