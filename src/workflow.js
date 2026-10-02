export const phases = ['preparation', 'requirements', 'development', 'demo', 'pr_review', 'refactoring', 'handoff'];

export const reviewChecks = ['features', 'readability', 'formatting', 'tests', 'architecture'];

export function validateReview(reply) {
  if (!Array.isArray(reply.findings) || reply.findings.some(item => typeof item !== 'string' || !item.trim()) ||
      !Array.isArray(reply.tests) || !reply.tests.length || reply.tests.some(item => typeof item !== 'string' || !item.trim()) ||
      reviewChecks.some(key => typeof reply.checks?.[key]?.passed !== 'boolean' || typeof reply.checks[key].evidence !== 'string' || !reply.checks[key].evidence.trim())) {
    throw new Error('PR review requires findings[], nonempty tests[] and checks with passed and evidence for features, readability, formatting, tests, architecture');
  }
  if (!reply.findings.length && reviewChecks.some(key => !reply.checks[key].passed)) {
    throw new Error('Failed or unverified checks must include actionable findings');
  }
}

export function validateRefactoring(reply) {
  if (!Array.isArray(reply.addressedFindings) || !reply.addressedFindings.length || reply.addressedFindings.some(item => typeof item !== 'string' || !item.trim()) ||
      typeof reply.uiChanged !== 'boolean' || !Array.isArray(reply.impact) || reply.impact.some(item => !item || typeof item.file !== 'string' || typeof item.description !== 'string') ||
      !Array.isArray(reply.tests) || !reply.tests.length || reply.tests.some(item => typeof item !== 'string' || !item.trim())) {
    throw new Error('Refactoring requires addressedFindings[], uiChanged, impact[] and nonempty tests[]');
  }
}
