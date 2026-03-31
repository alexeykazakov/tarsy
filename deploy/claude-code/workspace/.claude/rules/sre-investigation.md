---
description: Rules for SRE incident investigation
---

# SRE Investigation Rules

- Always verify the current state of resources before making assumptions
- Check for recent deployments or configuration changes that may have caused the issue
- Include timestamps and resource names in your findings
- If kubectl commands fail, report the error and try alternative approaches
- Do not make changes to the cluster unless explicitly instructed to remediate
- Focus on gathering evidence and documenting the root cause
