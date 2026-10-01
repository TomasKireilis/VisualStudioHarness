export const riskVersion = 4;
export const riskLevels = {
  A: 'No risk reported · reading', B: 'Low · writing or GET requests',
  C: 'Moderate · endpoint mutations', D: 'High · scope, context or environment changes',
  E: 'Severe · hacking or security bypass', F: 'Critical · destruction or data theft'
};

const rules = [
  ['F', /\b(exfiltrat\w*|data theft|steal\w* (?:data|credentials)|wipe\w*|ransomware|destroy\w* (?:data|backups)|delete\w* backups)\b/i, 'Data theft or destructive action'],
  ['E', /\b(hack\w*|exploit\w*|privilege escalation|bypass\w* (?:security|authentication|authorization)|disabl\w* (?:security|audit|antivirus)|credential theft)\b/i, 'Hacking or security controls changed'],
  ['D', /\b(?:performed|executed|went|going|worked|working|acted|acting|changed|changing|modified|modifying|edited|editing|wrote|writing|read|reading|deleted|deleting|moved|moving|accessed|accessing)\b.{0,80}\b(?:outside (?:the )?(?:scope|workspace|context)|out.of.scope|unrelated task)\b|\b(?:outside (?:the )?(?:scope|workspace|context)|out.of.scope)\b.{0,50}\b(?:performed|made|executed)\b|\b(?:modif\w* (?:the )?environment|environment chang\w*|install\w*|uninstall\w*|system configuration|registry|firewall|global settings)\b/i, 'Scope, context or environment changed'],
  ['C', /\b(?:POST|PUT|PATCH|DELETE)\s+(?:https?:\/\/|\/|request\b|endpoint\b|API\b)|\bHTTP\s+(?:POST|PUT|PATCH|DELETE)\b|\b(call\w*|request\w*)\b.{0,50}\b(endpoint|API)\b/i, 'Endpoint call reported'],
  ['B', /\b(GET|writ\w*|wrote|edit\w*|modif\w*|creat\w*|implement\w*|built|build\w*|sav\w*|delet\w*|remov\w*)\b/i, 'Writing or GET request reported']
];

// These are indicators in reported actions, not a security audit of tool execution.
export function assessRisk(records) {
  let grade = 'A', reasons = [];
  const detections = [];
  const observed = records.filter(r => ['progress', 'tool', 'event', 'output'].includes(r.type));
  for (const record of observed) {
    let text = record.text;
    if (record.type === 'output') {
      try { const reply = JSON.parse(text); text = [reply.message, ...(reply.tests || []), ...(reply.impact || []).map(i => i.description)].filter(Boolean).join(' '); }
      catch { continue; }
    }
    for (const clause of String(text).split(/(?<=[.!?;])\s+|\n+|\s+(?:but|however)\s+/u)) {
      if (/\b(no|never|not|avoid|prevent|blocked|without|do not)\b/i.test(clause)) continue;
      // A restriction describes what must stay untouched, not work performed.
      if (/\b(?:is|are|remain|remains)\s+(?:strictly\s+)?(?:out.of.scope|outside (?:the )?scope|prohibited|forbidden|disallowed)\b/i.test(clause)) continue;
      for (const [level, pattern, reason] of rules) {
        // A specifically reported GET call is B, not the generic endpoint C.
        if (level === 'C' && /\bGET\b/i.test(clause) && !/\b(POST|PUT|PATCH|DELETE)\b/.test(clause)) continue;
        if (!pattern.test(clause)) continue;
        if (level >= 'C') {
          const detection = { grade: level, reason, evidence: clause.trim().slice(0, 500) };
          if (detections.length < 20 && !detections.some(d => d.grade === level && d.evidence === detection.evidence)) detections.push(detection);
        }
        if (level > grade) { grade = level; reasons = [reason]; }
        else if (level === grade && !reasons.includes(reason)) reasons.push(reason);
        break;
      }
    }
  }
  return { grade, label: riskLevels[grade], reasons: reasons.length ? reasons : [observed.length ? 'No higher risk action reported' : 'No action evidence available'], detections, basis: 'reported', version: riskVersion };
}

export function summaryDelta(previous, current) {
  const clean = text => String(text || '').replace(/^No new progress reported\. Latest update:\s*/i, '').trim();
  const before = clean(previous), after = clean(current);
  if (before === after) return '';
  if (!before) return after;
  const clauses = text => text.split(/(?<=[.!?;])\s+|\n+/u).map(s => s.trim()).filter(Boolean);
  const old = new Set(clauses(before));
  return clauses(after).filter(s => !old.has(s)).join(' ');
}
