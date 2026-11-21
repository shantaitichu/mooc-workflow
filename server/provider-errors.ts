/** A request may have reached the vendor. Never blindly resubmit or release its hold. */
export class UncertainSubmission extends Error {}
