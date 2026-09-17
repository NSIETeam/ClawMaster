# Agent Note: check order and inventory grants in one policy snapshot

Status: implemented

English | [中文](2026-09-17-order-submit-policy-snapshot.zh.md)

## Problem

Submitting an order changes the order and each referenced inventory row. Separate asynchronous permission checks can observe different membership versions, and approval waits allow any affected grant to be revoked before the mutation.

## Decision

`GovernanceCaller.checkMany` reads the executor and delegator memberships once and requires every requested resource grant from that policy snapshot. HTTP and DSH tool order submissions call it after approval for the order and every referenced inventory item. The resulting identity carries that snapshot's policy version and retains the approval evidence already consumed for the command.

Approver grant checks use the same exact, family-wildcard and global resource matcher as executor checks. A family grant remains limited to its resource family.

## Alternatives considered

- **Check each inventory item separately and select the highest policy version.** Each result may describe a different policy state, so the selected version can imply a combined authorization that never existed.
- **Rely on the pre-approval resource checks.** Membership can change while DSH or enterprise approval is pending.
- **Reject family-wide approver grants.** That contradicts the resource grant format accepted for executors and makes equivalent configured permissions behave differently.

## Verification

Governance tests revoke inventory access during both HTTP authority approval and DSH tool approval, change order access during the final membership read, update the policy version while retaining a valid approval, and authorize a family-scoped approver. The original implementation allows the revoked HTTP and final-snapshot cases and rejects the family-scoped approval; the updated cases pass.

## Consequences

- One multi-resource decision uses one authority membership snapshot instead of combining independent snapshots.
- Revocation observed at the post-approval check prevents the transaction.
- An authority can still change after that check and before SQLite commits; eliminating that interval requires the authority and business mutation to share a transactional authorization protocol.
