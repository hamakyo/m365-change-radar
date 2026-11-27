import type { ImpactState } from '../domain/impact-assessment.js';
import type { JsonValue } from '../domain/json-value.js';
import type {
  AIInference,
  DeterministicConclusion,
  TenantFact,
} from '../domain/provenance.js';
import type { SuggestedChangeActionKind } from '../domain/suggested-change-action.js';
import {
  DigestBundleSchema,
  type DigestBundle,
  type DigestChangeEntry,
  type DigestPersonaOutcome,
} from './digest-bundle.js';

const STATE_PRIORITY: Readonly<Record<ImpactState, number>> = {
  ACTION_REQUIRED: 0,
  REVIEW_REQUIRED: 1,
  INSUFFICIENT_CONTEXT: 2,
  INFORMATIONAL: 3,
  NOT_APPLICABLE: 4,
};

const RISK_RULE_SUMMARY_JA: Readonly<Record<string, string>> = {
  'major-change':
    '重大変更シグナル (`signals.isMajorChange = true`) により `REVIEW_REQUIRED` 下限を適用',
  'admin-action-deadline':
    '管理者対応期限 (`signals.actionRequiredBy`) の存在により `ACTION_REQUIRED` 下限を適用',
  'high-or-critical-severity':
    '重大度 `high` 以上により `REVIEW_REQUIRED` 下限を適用',
  'admin-impact-and-severity':
    '管理者影響かつ重大度 `high` 以上により `ACTION_REQUIRED` 下限を適用',
  'retirement-or-deprecation':
    '廃止・非推奨シグナル (`isRetirementOrDeprecation` / タグ) により `REVIEW_REQUIRED` 下限を適用',
  'security-impact':
    'セキュリティ影響シグナル (`hasSecurityImpact` / `security` タグ) により `ACTION_REQUIRED` 下限を適用',
  'privacy-or-compliance-impact':
    'プライバシー・コンプライアンス影響シグナル (`hasComplianceImpact` 等) により `REVIEW_REQUIRED` 下限を適用',
};

const ACTION_KIND_JA: Readonly<Record<SuggestedChangeActionKind, string>> = {
  INVESTIGATE: '現状調査',
  PLAN: '対応計画策定',
  IMPLEMENT: '設定変更適用',
  COMMUNICATE: '関係者周知',
  VALIDATE: '適用後検証',
};

function escapeCell(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('|', '\\|')
    .replaceAll('\r\n', ' ')
    .replaceAll('\n', ' ')
    .replaceAll('\r', ' ');
}

function formatIsoDateShort(iso: string): string {
  return iso.slice(0, 10);
}

type ExtractedRoadmapMetadata = {
  readonly roadmapUrl: string;
  readonly status: string;
  readonly releasePhases: string[];
  readonly gaDate: string | null;
  readonly previewDate: string | null;
  readonly moreInfoLink: string | null;
  readonly cloudInstances: string[];
  readonly platforms: string[];
};

function asStringOrNull(value: JsonValue | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asStringArray(value: JsonValue | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function extractMetadata(entry: DigestChangeEntry): ExtractedRoadmapMetadata {
  const meta =
    typeof entry.changeEvent.sourceMetadata === 'object' &&
    entry.changeEvent.sourceMetadata !== null &&
    !Array.isArray(entry.changeEvent.sourceMetadata)
      ? (entry.changeEvent.sourceMetadata as Record<string, JsonValue>)
      : {};

  const externalId = entry.changeEvent.externalId;
  const roadmapUrl =
    asStringOrNull(meta.roadmapUrl) ??
    `https://www.microsoft.com/microsoft-365/roadmap?id=${encodeURIComponent(externalId)}`;

  return {
    roadmapUrl,
    status: asStringOrNull(meta.status) ?? '未記載',
    releasePhases: asStringArray(meta.releasePhases),
    gaDate: asStringOrNull(meta.publicDisclosureAvailabilityDate),
    previewDate: asStringOrNull(meta.publicPreviewDate),
    moreInfoLink: asStringOrNull(meta.moreInfoLink),
    cloudInstances: asStringArray(meta.cloudInstances),
    platforms: asStringArray(meta.platforms),
  };
}

function highestPriorityState(entry: DigestChangeEntry): ImpactState {
  let best: ImpactState = 'NOT_APPLICABLE';
  for (const outcome of entry.outcomes) {
    const candidate = outcome.analysisRecord.impactAssessment.state;
    if (STATE_PRIORITY[candidate] < STATE_PRIORITY[best]) {
      best = candidate;
    }
  }
  return best;
}

function collectProvenanceByKind(outcome: DigestPersonaOutcome): {
  readonly tenantFacts: TenantFact[];
  readonly riskConclusions: DeterministicConclusion[];
  readonly tenantConclusions: DeterministicConclusion[];
  readonly aiInferences: AIInference[];
} {
  const tenantFacts: TenantFact[] = [];
  const riskConclusions: DeterministicConclusion[] = [];
  const tenantConclusions: DeterministicConclusion[] = [];
  const aiInferences: AIInference[] = [];

  for (const record of outcome.analysisRecord.provenanceRecords) {
    if (record.kind === 'tenant_fact') {
      tenantFacts.push(record);
    } else if (record.kind === 'deterministic_conclusion') {
      if (record.policyKind === 'risk_policy') {
        riskConclusions.push(record);
      } else {
        tenantConclusions.push(record);
      }
    } else if (record.kind === 'ai_inference') {
      aiInferences.push(record);
    }
  }

  return {
    tenantFacts,
    riskConclusions,
    tenantConclusions,
    aiInferences,
  };
}

function formatTenantObservation(fact: TenantFact): string {
  if (fact.observation.presence === 'absent') {
    return `\`${fact.path}\` = 未定義 (absent)`;
  }
  return `\`${fact.path}\` = \`${JSON.stringify(fact.observation.value)}\``;
}

function summarizeTenantConclusionJa(c: DeterministicConclusion): string {
  if (c.conclusion.includes('condition group MATCH:')) {
    return `ルール \`${c.ruleId}\` 一致（適用対象）`;
  }
  if (c.conclusion.includes('condition group NO_MATCH:')) {
    return `ルール \`${c.ruleId}\` 不一致（対象外）`;
  }
  if (c.conclusion.includes('condition group UNKNOWN:')) {
    return `ルール \`${c.ruleId}\` 保留（未定義キーあり）`;
  }
  return `ルール \`${c.ruleId}\``;
}

function isFiringRiskConclusion(conclusion: string): boolean {
  if (
    conclusion.startsWith('all_of evaluated as ') ||
    conclusion.startsWith('any_of evaluated as ')
  ) {
    return (
      conclusion.includes('evaluated as MATCH:') ||
      conclusion.includes('evaluated as UNKNOWN:')
    );
  }
  if (conclusion.includes('was not reported;')) return true;
  if (conclusion.startsWith('severity is ')) {
    return (
      conclusion.startsWith('severity is high;') ||
      conclusion.startsWith('severity is critical;')
    );
  }
  return (
    conclusion.includes('and matches ') ||
    conclusion.includes('contains a deadline') ||
    conclusion.includes('contains the normalized tag')
  );
}

function summarizeRiskConclusionJa(rc: DeterministicConclusion): string {
  if (
    rc.conclusion.includes('was not reported;') ||
    rc.conclusion.includes('evaluated as UNKNOWN:')
  ) {
    return `必須シグナル未報告 (\`UNKNOWN\`) により安全側 \`REVIEW_REQUIRED\` 下限を適用`;
  }
  return RISK_RULE_SUMMARY_JA[rc.ruleId] ?? '高リスク条件一致により下限を適用';
}

function summarizeClassifierReasonJa(proposedState: string): string {
  if (proposedState === 'REVIEW_REQUIRED') {
    return '適用対象サービスに対する管理者影響シグナル (`hasAdminImpact = true`) により要確認と判定';
  }
  return '外部 LLM 非使用の決定論的ルールにより `INFORMATIONAL` を初期提案';
}

function renderActionableEntrySection(entry: DigestChangeEntry): string {
  const meta = extractMetadata(entry);
  const ev = entry.changeEvent;
  const components =
    ev.products.length > 0 ? ev.products.join(', ') : '対象 M365 サービス';
  const lines: string[] = [];

  lines.push(`### Feature ID ${escapeCell(ev.externalId)}: ${ev.title}`);
  lines.push('');

  // Layer 1: Microsoft Source Facts
  lines.push('#### 1. Microsoft 公開ソース事実 (source_fact)');
  lines.push('');
  const learnSuffix =
    meta.moreInfoLink !== null
      ? ` / [Microsoft Learn](${meta.moreInfoLink})`
      : '';
  lines.push(
    `- **Feature ID / リンク**: \`${ev.externalId}\` ([Roadmap](${meta.roadmapUrl})${learnSuffix})`,
  );
  lines.push(
    `- **状態 / フェーズ**: \`${meta.status}\` (${meta.releasePhases.length > 0 ? meta.releasePhases.map((p) => `\`${p}\``).join(', ') : '未記載'})`,
  );
  lines.push(
    `- **提供予定時期**: GA \`${meta.gaDate ?? '未公表'}\` / Preview \`${meta.previewDate ?? '未公表'}\``,
  );
  lines.push(
    `- **公開日時 / 更新日時**: \`${ev.publishedAt}\` / \`${ev.updatedAt}\` (\`${entry.sourceMessageVersion}\`)`,
  );
  lines.push(
    `- **正規化対象製品**: ${ev.products.map((p) => `\`${p}\``).join(', ')}`,
  );
  if (meta.cloudInstances.length > 0) {
    lines.push(
      `- **展開先クラウド**: ${meta.cloudInstances.map((c) => `\`${c}\``).join(', ')}`,
    );
  }
  const activeSignals = Object.entries(ev.signals ?? {})
    .filter(([key, val]) => key !== 'tags' && val === true)
    .map(([key]) => `\`${key}=true\``);
  lines.push(
    `- **発火シグナル**: ${activeSignals.length > 0 ? activeSignals.join(', ') : 'なし（全項目 `false` / `null` 確認済み）'}`,
  );
  lines.push('');

  // Layer 2: Tenant Profile Facts & Applicability Conclusions
  lines.push(
    '#### 2. ペルソナ別テナント事実と適用性判定 (tenant_fact / tenant_applicability_policy)',
  );
  lines.push('');
  lines.push(
    '| ペルソナ ID | 最終ステート | 参照テナント事実 | 適用性ルール判定 |',
  );
  lines.push('| --- | --- | --- | --- |');
  for (const outcome of entry.outcomes) {
    const { tenantFacts, tenantConclusions } = collectProvenanceByKind(outcome);
    const assessment = outcome.analysisRecord.impactAssessment;
    const inspectedFacts = tenantFacts
      .filter(
        (f) =>
          f.path.startsWith('services.') ||
          f.path.startsWith('environment.') ||
          f.path.startsWith('capabilities.'),
      )
      .map(formatTenantObservation);
    const tenantCell =
      inspectedFacts.length > 0
        ? inspectedFacts.map(escapeCell).join('<br>')
        : '参照なし';

    const matchedTenantConclusions = tenantConclusions.filter(
      (c) => !c.conclusion.startsWith('selector NO_MATCH:'),
    );
    let conclusionParts: string[] = matchedTenantConclusions.map(
      summarizeTenantConclusionJa,
    );
    if (assessment.state === 'INSUFFICIENT_CONTEXT') {
      if (assessment.missingContext !== undefined) {
        conclusionParts = [
          ...conclusionParts,
          `未設定キー: \`${assessment.missingContext.join(', ')}\``,
        ];
      }
      if (assessment.missingMappings !== undefined) {
        conclusionParts = [
          ...conclusionParts,
          `未定義タグ: \`${assessment.missingMappings.map((m) => `${m.field}=${String(m.value)}`).join(', ')}\``,
        ];
      }
    }
    const conclusionCell =
      conclusionParts.length > 0
        ? conclusionParts.map(escapeCell).join('<br>')
        : '該当ルールなし';

    lines.push(
      `| \`${escapeCell(outcome.personaId)}\` | \`${assessment.state}\` | ${tenantCell} | ${conclusionCell} |`,
    );
  }
  lines.push('');

  // Layer 3: Deterministic Risk Policy Conclusions
  lines.push('#### 3. 決定論的リスクガードレール結論 (risk_policy)');
  lines.push('');
  const firstOutcome = entry.outcomes[0];
  const riskConclusions =
    firstOutcome !== undefined
      ? collectProvenanceByKind(firstOutcome).riskConclusions
      : [];
  const activeRiskConclusions = riskConclusions.filter((rc) =>
    isFiringRiskConclusion(rc.conclusion),
  );
  const nonMatchingRiskCount =
    riskConclusions.length - activeRiskConclusions.length;
  if (activeRiskConclusions.length > 0) {
    for (const rc of activeRiskConclusions) {
      lines.push(
        `- **ルール \`${rc.ruleId}\`** (\`${rc.policyRulesVersion}\`, \`${rc.evidenceId}\`): ${summarizeRiskConclusionJa(rc)}`,
      );
    }
    if (nonMatchingRiskCount > 0) {
      lines.push(
        `- *(他 ${nonMatchingRiskCount} 件のガードレールルールは不一致 \`NO_MATCH\`)*`,
      );
    }
  } else {
    lines.push(
      '- 高リスク下限ルール (`ACTION_REQUIRED` / `REVIEW_REQUIRED`) の発火なし (`finalStateFloor = null`)。',
    );
  }
  lines.push('');

  // Layer 4: Classifier / AI Inference Provenance
  lines.push('#### 4. 分類器判定 (ai_inference)');
  lines.push('');
  const outcomesWithAi = entry.outcomes.filter(
    (o) => o.analysisRecord.versionBundle.ai.used,
  );
  if (outcomesWithAi.length === 0) {
    lines.push(
      '- 全ペルソナで決定論的最終判定 (`versionBundle.ai.used = false`) により完結。',
    );
  } else {
    for (const outcome of outcomesWithAi) {
      const { aiInferences } = collectProvenanceByKind(outcome);
      for (const inf of aiInferences) {
        const proposed = inf.classificationOutput?.proposedState ?? '不明';
        const finalState = outcome.analysisRecord.impactAssessment.state;
        const mergeNote =
          proposed !== finalState
            ? `ガードレールにより \`${proposed}\` から \`${finalState}\` へ引き上げ`
            : `提案ステート \`${proposed}\` を採用`;
        lines.push(
          `- **\`${outcome.personaId}\`** (\`${inf.model}@${inf.modelVersion}\`): ${mergeNote} — ${summarizeClassifierReasonJa(proposed)}`,
        );
      }
    }
  }
  lines.push('');

  // Layer 5: Suggested Checklist Actions (concise Japanese audit rows)
  lines.push('#### 5. ペルソナ別推奨チェックリスト (SuggestedChangeAction)');
  lines.push('');
  for (const outcome of entry.outcomes) {
    const actionResult = outcome.suggestedChangeActionResult;
    if (actionResult === undefined) continue;
    lines.push(
      `**\`${outcome.personaId}\` (\`${outcome.analysisRecord.impactAssessment.state}\`)**`,
    );
    lines.push('');
    for (const action of actionResult.actions) {
      const ownerPart =
        action.ownerKey !== undefined ? `, owner: \`${action.ownerKey}\`` : '';
      const duePart =
        action.dueAt !== undefined ? `, dueAt: \`${action.dueAt}\`` : '';
      lines.push(
        `- [ ] **[${ACTION_KIND_JA[action.kind]}]** \`${components}\` の${ACTION_KIND_JA[action.kind]}を実施する *(id: \`${action.actionId}\`, origin: \`${action.origin}\`${ownerPart}${duePart})*`,
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Render a concise Japanese technical audit ledger (`digest-ja.md`) from a
 * validated `DigestBundle`.
 */
export function renderDigestMarkdownJa(bundleInput: DigestBundle): string {
  const bundle = DigestBundleSchema.parse(bundleInput);
  const sinceDate = formatIsoDateShort(bundle.window.since);
  const untilDate = formatIsoDateShort(bundle.window.until);

  const lines: string[] = [];
  lines.push(
    `# Microsoft 365 週次変更影響ダイジェスト監査台帳 (${sinceDate} - ${untilDate})`,
  );
  lines.push('');
  lines.push(
    `公開ロードマップ (\`${bundle.feedSource.location}\`) の直近 ${bundle.window.days} 日間における更新 ${bundle.summary.changeCount} 件（うちソブリンクラウド専用除外 ${bundle.summary.sovereignCloudExcludedCount} 件）を ${bundle.summary.personaCount} ペルソナに対して評価した技術監査台帳です（外部 LLM API 呼び出し 0 回）。`,
  );
  lines.push('');

  // Section 1: Executive Summary by Persona
  lines.push('## ペルソナ別影響サマリー');
  lines.push('');
  lines.push(
    '| ペルソナ ID | 従業員規模 | プロファイル版 | ACTION_REQUIRED | REVIEW_REQUIRED | INSUFFICIENT_CONTEXT | INFORMATIONAL | NOT_APPLICABLE | 推奨アクション数 |',
  );
  lines.push('| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const persona of bundle.personas) {
    const emp =
      persona.employees !== undefined ? `${persona.employees} 名` : '未指定';
    const sc = persona.stateCounts;
    lines.push(
      `| \`${escapeCell(persona.personaId)}\` | ${emp} | \`${escapeCell(persona.profileVersion)}\` | ${sc.ACTION_REQUIRED} | ${sc.REVIEW_REQUIRED} | ${sc.INSUFFICIENT_CONTEXT} | ${sc.INFORMATIONAL} | ${sc.NOT_APPLICABLE} | ${persona.actionCount} |`,
    );
  }
  lines.push('');

  const actionableEntries = bundle.entries
    .filter((entry) =>
      entry.outcomes.some(
        (o) =>
          o.analysisRecord.impactAssessment.state === 'ACTION_REQUIRED' ||
          o.analysisRecord.impactAssessment.state === 'REVIEW_REQUIRED',
      ),
    )
    .sort((a, b) => {
      const stateDiff =
        STATE_PRIORITY[highestPriorityState(a)] -
        STATE_PRIORITY[highestPriorityState(b)];
      if (stateDiff !== 0) return stateDiff;
      return (
        Date.parse(b.changeEvent.updatedAt) -
        Date.parse(a.changeEvent.updatedAt)
      );
    });

  // Section 2: Actionable & Review Items
  lines.push('## 対応およびレビュー対象の変更一覧');
  lines.push('');
  if (actionableEntries.length === 0) {
    lines.push(
      '対象期間内に `ACTION_REQUIRED` または `REVIEW_REQUIRED` と判定された変更はありません。',
    );
    lines.push('');
  } else {
    for (const entry of actionableEntries) {
      lines.push(renderActionableEntrySection(entry));
    }
  }

  // Section 3: Insufficient Context / Mapping Gaps
  const insufficientOutcomes: Array<{
    readonly entry: DigestChangeEntry;
    readonly outcome: DigestPersonaOutcome;
  }> = [];
  for (const entry of bundle.entries) {
    for (const outcome of entry.outcomes) {
      if (
        outcome.analysisRecord.impactAssessment.state === 'INSUFFICIENT_CONTEXT'
      ) {
        insufficientOutcomes.push({ entry, outcome });
      }
    }
  }

  lines.push('## コンテキスト不足およびマッピング未定義の項目');
  lines.push('');
  if (insufficientOutcomes.length === 0) {
    lines.push(
      '対象期間内に `INSUFFICIENT_CONTEXT` と判定されたペルソナ評価はありません。',
    );
    lines.push('');
  } else {
    lines.push(
      '| Feature ID | タイトル | ペルソナ ID | 未設定パス (`missingContext`) | 未定義タグ (`missingMappings`) |',
    );
    lines.push('| --- | --- | --- | --- | --- |');
    for (const { entry, outcome } of insufficientOutcomes) {
      const meta = extractMetadata(entry);
      const assessment = outcome.analysisRecord.impactAssessment;
      if (assessment.state !== 'INSUFFICIENT_CONTEXT') continue;
      const missingCtx =
        assessment.missingContext !== undefined &&
        assessment.missingContext.length > 0
          ? assessment.missingContext
              .map((p) => `\`${escapeCell(p)}\``)
              .join('<br>')
          : 'なし';
      const missingMap =
        assessment.missingMappings !== undefined &&
        assessment.missingMappings.length > 0
          ? assessment.missingMappings
              .map(
                (m) =>
                  `\`${escapeCell(m.field)}: ${escapeCell(String(m.value))}\``,
              )
              .join('<br>')
          : 'なし';
      lines.push(
        `| [\`${escapeCell(entry.changeEvent.externalId)}\`](${meta.roadmapUrl}) | ${escapeCell(entry.changeEvent.title)} | \`${escapeCell(outcome.personaId)}\` | ${missingCtx} | ${missingMap} |`,
      );
    }
    lines.push('');
  }

  // Section 4: Informational & Not Applicable Overview
  const nonActionableEntries = bundle.entries.filter((entry) =>
    entry.outcomes.every(
      (o) =>
        o.analysisRecord.impactAssessment.state !== 'ACTION_REQUIRED' &&
        o.analysisRecord.impactAssessment.state !== 'REVIEW_REQUIRED',
    ),
  );

  lines.push('## 情報共有および対象外の変更一覧');
  lines.push('');
  if (nonActionableEntries.length === 0) {
    lines.push(
      '`INFORMATIONAL` または `NOT_APPLICABLE` のみで構成される変更はありません。',
    );
    lines.push('');
  } else {
    const personaHeaders = bundle.personas
      .map((p) => `\`${escapeCell(p.personaId)}\``)
      .join(' | ');
    const personaSeparators = bundle.personas.map(() => '---').join(' | ');
    lines.push(
      `| Feature ID | 更新日 | 正規化製品 | タイトル | ${personaHeaders} |`,
    );
    lines.push(`| --- | --- | --- | --- | ${personaSeparators} |`);
    for (const entry of nonActionableEntries) {
      const meta = extractMetadata(entry);
      const outcomeByPersona = new Map(
        entry.outcomes.map((o) => [
          o.personaId,
          o.analysisRecord.impactAssessment.state,
        ]),
      );
      const stateCells = bundle.personas
        .map((p) => `\`${outcomeByPersona.get(p.personaId) ?? 'N/A'}\``)
        .join(' | ');
      const prods =
        entry.changeEvent.products.length > 0
          ? entry.changeEvent.products.map(escapeCell).join(', ')
          : '未記載';
      lines.push(
        `| [\`${escapeCell(entry.changeEvent.externalId)}\`](${meta.roadmapUrl}) | \`${formatIsoDateShort(entry.changeEvent.updatedAt)}\` | ${prods} | ${escapeCell(entry.changeEvent.title)} | ${stateCells} |`,
      );
    }
    lines.push('');
  }

  // Section 5: Reproducibility & Policy Metadata
  lines.push('## 再現メタデータとポリシーバージョン');
  lines.push('');
  lines.push(`- **生成基準日時 (generatedAt)**: \`${bundle.generatedAt}\``);
  lines.push(
    `- **評価対象ウィンドウ**: \`${bundle.window.since}\` 〜 \`${bundle.window.until}\` (${bundle.window.days} 日間 / 上限 ${bundle.window.limit} 件)`,
  );
  lines.push(
    `- **入力フィード**: \`${bundle.feedSource.mode}\` (\`${bundle.feedSource.location}\`, 取得総数 ${bundle.feedSource.fetchedItemCount} 件 / 選定 ${bundle.feedSource.selectedItemCount} 件)`,
  );
  lines.push(
    `- **リスクポリシー**: \`${bundle.policyVersions.riskPolicyId}\` (\`${bundle.policyVersions.riskPolicyRulesVersion}\`)`,
  );
  lines.push(
    `- **テナント適用性ポリシー**: \`${bundle.policyVersions.tenantApplicabilityPolicyId}\` (\`${bundle.policyVersions.tenantApplicabilityPolicyRulesVersion}\`)`,
  );

  return `${lines.join('\n')}\n`;
}
