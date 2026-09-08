// Assumptions behind the scan report's headline number (F-ADM-4): estimated
// hours per week spent re-answering questions the company's sources disagree
// on. Every number here is printed in the report's "how this is estimated"
// section; change them here, not in the renderer.

export const SCAN_REPORT_ASSUMPTIONS = {
  /** Minutes a person spends re-answering one question whose sources disagree (find both, reconcile, reply). */
  minutesPerReanswer: 10,
  /** Floor on how often each open contradiction or drift is re-asked, per week, when chat gives no evidence. */
  minReasksPerWeek: 0.5,
  /** Shortest observation window (weeks) used when inferring re-ask rates from chat and tickets. */
  minObservedWeeks: 4,
  /** Implied-knowledge gaps rendered in full before the rest are summarised as a count. */
  maxGapsShown: 20,
} as const;
