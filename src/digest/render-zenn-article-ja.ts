import type { ImpactState } from '../domain/impact-assessment.js';
import type { JsonValue } from '../domain/json-value.js';
import type {
  SuggestedChangeAction,
  SuggestedChangeActionKind,
} from '../domain/suggested-change-action.js';
import {
  DigestBundleSchema,
  type DigestBundle,
  type DigestChangeEntry,
  type DigestPersonaOutcome,
  type DigestPersonaSummary,
} from './digest-bundle.js';

const STATE_PRIORITY: Readonly<Record<ImpactState, number>> = {
  ACTION_REQUIRED: 0,
  REVIEW_REQUIRED: 1,
  INSUFFICIENT_CONTEXT: 2,
  INFORMATIONAL: 3,
  NOT_APPLICABLE: 4,
};

const STATE_LABEL_JA: Readonly<Record<ImpactState, string>> = {
  ACTION_REQUIRED: '対応必須',
  REVIEW_REQUIRED: '要確認',
  INSUFFICIENT_CONTEXT: '設定の棚卸し待ち',
  INFORMATIONAL: '情報共有',
  NOT_APPLICABLE: '対象外',
};

const STATUS_LABEL_JA: Readonly<Record<string, string>> = {
  'In development': '開発中',
  'Rolling out': 'ロールアウト中',
  Launched: '提供開始済み',
  Cancelled: '計画中止',
};

const PERSONA_DISPLAY_META: Readonly<
  Record<
    string,
    {
      readonly order: number;
      readonly label: string;
      readonly shortLabel: string;
      readonly contextSummary: string;
    }
  >
> = {
  'jp-small-teams-exo': {
    order: 1,
    label: '40名 Teams+EXO最小構成',
    shortLabel: '40名最小構成',
    contextSummary:
      'Exchange Online・Teams中心 / Intune・Defender未導入 / Purview・Power Platform未棚卸し',
  },
  'jp-smb-m365-bp-intune': {
    order: 2,
    label: '150名 Business Premium+Intune標準構成',
    shortLabel: '150名BP標準構成',
    contextSummary:
      'Windows・iOS Intune管理 / Entra ID条件付きアクセス有効 / M365 Copilot未棚卸し',
  },
  'jp-enterprise-hybrid-e3': {
    order: 3,
    label: '600名 Hybrid E3+Purview/Viva構成',
    shortLabel: '600名Hybrid E3構成',
    contextSummary:
      'ハイブリッドEntra ID・Exchange / Purview・Defender・Power Platform・Viva・Copilot稼働',
  },
};

const ADMIN_PORTAL_BY_PRODUCT: Readonly<Record<string, string>> = {
  'Microsoft Purview': 'Microsoft Purview ポータル',
  'Microsoft Teams': 'Microsoft Teams 管理センター',
  'Microsoft Intune': 'Microsoft Intune 管理センター',
  'Microsoft Entra ID': 'Microsoft Entra 管理センター',
  'Exchange Online': 'Exchange 管理センター',
  Outlook: 'Exchange 管理センター（Outlook ポリシー）',
  'SharePoint Online': 'SharePoint 管理センター',
  OneDrive: 'SharePoint 管理センター（OneDrive 設定）',
  'Microsoft Defender for Office 365': 'Microsoft Defender ポータル',
  'Microsoft Defender': 'Microsoft Defender ポータル',
  'Microsoft Power Platform': 'Power Platform 管理センター',
  'Microsoft Viva': 'Microsoft 365 管理センター（Viva アクセス管理）',
  'Microsoft 365 Copilot': 'Microsoft 365 管理センター（Copilot 設定）',
  'Microsoft Edge': 'Microsoft 365 管理センター（Edge 管理サービス）',
  'Microsoft 365 Apps': 'Microsoft 365 Apps 管理センター',
  'Microsoft 365': 'Microsoft 365 管理センター',
};

const OWNERSHIP_SERVICE_KEY_BY_PRODUCT: Readonly<
  Record<string, readonly string[]>
> = {
  'Microsoft Purview': ['purview_compliance', 'microsoft_365'],
  'Microsoft Teams': ['teams', 'microsoft_365'],
  'Microsoft Intune': ['intune', 'microsoft_365'],
  'Microsoft Entra ID': ['entra_id', 'microsoft_365'],
  'Exchange Online': ['exchange_online', 'microsoft_365'],
  Outlook: ['exchange_online', 'microsoft_365'],
  'SharePoint Online': ['sharepoint_online', 'microsoft_365'],
  OneDrive: ['sharepoint_online', 'microsoft_365'],
  'Microsoft Defender for Office 365': [
    'defender_for_office_365',
    'defender_for_endpoint',
    'entra_id',
  ],
  'Microsoft Defender': [
    'defender_for_endpoint',
    'defender_for_office_365',
    'entra_id',
  ],
  'Microsoft Power Platform': ['power_platform', 'microsoft_365'],
  'Microsoft Viva': ['viva', 'teams', 'microsoft_365'],
  'Microsoft 365 Copilot': ['m365_copilot', 'microsoft_365'],
  'Microsoft Edge': ['intune', 'microsoft_365'],
  'Microsoft 365 Apps': ['intune', 'microsoft_365'],
  'Microsoft 365': ['microsoft_365', 'entra_id'],
};

const OWNER_ROLE_JA: Readonly<Record<string, string>> = {
  'it-generalist': 'ひとり情シス',
  'corporate-it-admin': 'コーポレートIT担当',
  'endpoint-admin': '端末管理担当',
  'soc-team': 'SOC・セキュリティ担当',
  'identity-security-team': 'ID・認証基盤担当',
  'messaging-ops-team': 'メール基盤担当',
  'collaboration-ops-team': 'コラボレーション基盤担当',
  'client-engineering-team': 'クライアント基盤担当',
  'information-governance-team': '情報ガバナンス担当',
  'citizen-dev-governance-team': '市民開発ガバナンス担当',
};

const PROFILE_PATH_LABEL_JA: Readonly<Record<string, string>> = {
  'services.purview_compliance': 'Microsoft Purview の利用有無',
  'services.power_platform': 'Power Platform の利用有無',
  'services.m365_copilot': 'Microsoft 365 Copilot の導入有無',
  'services.microsoft_365_apps': 'Microsoft 365 Apps の管理形態',
  'services.microsoft_edge': 'Microsoft Edge 管理ポリシーの有無',
  'services.intune': 'Microsoft Intune',
  'services.defender_for_office_365': 'Defender for Office 365',
  'services.defender_for_endpoint': 'Defender for Endpoint',
  'services.sharepoint_online': 'SharePoint Online / OneDrive',
  'services.viva': 'Microsoft Viva',
  'services.teams': 'Microsoft Teams',
  'services.exchange_online': 'Exchange Online',
  'services.entra_id': 'Microsoft Entra ID',
  'services.stream': 'Microsoft Stream',
  'services.windows_365': 'Windows 365',
  'services.dynamics_365': 'Dynamics 365',
  'environment.cloud_gcc': '米国政府 GCC クラウド',
  'environment.cloud_gcc_high': '米国政府 GCC High クラウド',
  'environment.cloud_dod': '米国防総省 DoD クラウド',
  'environment.cloud_china_21vianet': '中国 21Vianet クラウド',
};

const ACTION_KIND_LABEL_JA: Readonly<
  Record<SuggestedChangeActionKind, string>
> = {
  INVESTIGATE: '現状確認',
  PLAN: '対応計画',
  IMPLEMENT: '設定反映',
  COMMUNICATE: '関係者共有',
  VALIDATE: '動作検証',
};

const MAX_INFORMATIONAL_ROWS = 10;

function stripEmojis(text: string): string {
  return text.replace(/\p{Extended_Pictographic}/gu, '').replace(/\uFE0F/g, '');
}

function escapeCell(value: string): string {
  return stripEmojis(value)
    .replaceAll('\\', '\\\\')
    .replaceAll('|', '\\|')
    .replaceAll('\r\n', ' ')
    .replaceAll('\n', ' ')
    .replaceAll('\r', ' ');
}

function sanitizeHeadingTitle(value: string): string {
  return stripEmojis(value).replaceAll('、', ' / ').trim();
}

function formatDateSlash(iso: string): string {
  return iso.slice(0, 10).replaceAll('-', '/');
}

function formatDateShortMonthDay(iso: string): string {
  return iso.slice(5, 10).replaceAll('-', '/');
}

function formatPersonaLabel(personaId: string): string {
  return PERSONA_DISPLAY_META[personaId]?.label ?? personaId;
}

function formatStatusJa(status: string): string {
  return STATUS_LABEL_JA[status] ?? status;
}

function humanizeProfilePath(path: string): string {
  return PROFILE_PATH_LABEL_JA[path] ?? path;
}

function sortPersonasForDisplay(
  personas: readonly DigestPersonaSummary[],
): DigestPersonaSummary[] {
  return [...personas].sort((a, b) => {
    const orderA = PERSONA_DISPLAY_META[a.personaId]?.order ?? 99;
    const orderB = PERSONA_DISPLAY_META[b.personaId]?.order ?? 99;
    if (orderA !== orderB) return orderA - orderB;
    return a.personaId.localeCompare(b.personaId);
  });
}

type ZennItemMetadata = {
  readonly roadmapUrl: string;
  readonly status: string;
  readonly releasePhases: string[];
  readonly gaDate: string | null;
  readonly previewDate: string | null;
  readonly moreInfoLink: string | null;
  readonly cloudInstances: string[];
  readonly platforms: string[];
  readonly normalizedWorkloads: string[];
  readonly sovereignCloudOnly: boolean;
};

function asStringOrNull(value: JsonValue | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asStringArray(value: JsonValue | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function extractItemMetadata(entry: DigestChangeEntry): ZennItemMetadata {
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
  const normalizedWorkloads = asStringArray(meta.normalizedWorkloads);

  return {
    roadmapUrl,
    status: asStringOrNull(meta.status) ?? '未記載',
    releasePhases: asStringArray(meta.releasePhases),
    gaDate: asStringOrNull(meta.publicDisclosureAvailabilityDate),
    previewDate: asStringOrNull(meta.publicPreviewDate),
    moreInfoLink: asStringOrNull(meta.moreInfoLink),
    cloudInstances: asStringArray(meta.cloudInstances),
    platforms: asStringArray(meta.platforms),
    normalizedWorkloads:
      normalizedWorkloads.length > 0
        ? normalizedWorkloads
        : [...entry.changeEvent.products],
    sovereignCloudOnly: meta.sovereignCloudOnly === true,
  };
}

function resolvePortalPhrase(products: readonly string[]): string {
  for (const product of products) {
    const portal = ADMIN_PORTAL_BY_PRODUCT[product];
    if (portal !== undefined) return portal;
  }
  return 'Microsoft 365 管理センター';
}

function formatOwnerRoleClean(rawOwner: string): string {
  return OWNER_ROLE_JA[rawOwner] ?? rawOwner;
}

function resolveOwnerDisplayForWorkload(
  personaSummary: DigestPersonaSummary | undefined,
  products: readonly string[],
  fallbackOwnerKey: string | undefined,
): string {
  const ownership = personaSummary?.ownership;
  if (ownership !== undefined) {
    for (const product of products) {
      const candidateKeys = OWNERSHIP_SERVICE_KEY_BY_PRODUCT[product] ?? [];
      for (const serviceKey of candidateKeys) {
        const matchedOwner = ownership[serviceKey];
        if (matchedOwner !== undefined && matchedOwner.length > 0) {
          return formatOwnerRoleClean(matchedOwner);
        }
      }
    }
  }
  if (fallbackOwnerKey !== undefined && fallbackOwnerKey.length > 0) {
    const colonIdx = fallbackOwnerKey.indexOf(':');
    const rawOwner =
      colonIdx >= 0 ? fallbackOwnerKey.slice(colonIdx + 1) : fallbackOwnerKey;
    return formatOwnerRoleClean(rawOwner);
  }
  return 'IT管理者';
}

function formatScheduleWindow(meta: ZennItemMetadata): string {
  if (meta.previewDate !== null && meta.gaDate !== null) {
    return `Preview: ${meta.previewDate} / GA: ${meta.gaDate}`;
  }
  if (meta.gaDate !== null) {
    return `GA: ${meta.gaDate}`;
  }
  if (meta.previewDate !== null) {
    return `Preview: ${meta.previewDate}`;
  }
  return '時期未定';
}

function formatCloudSummaryJa(cloudInstances: readonly string[]): string {
  if (cloudInstances.length === 0) return '未指定';
  const labels = cloudInstances.map((c) =>
    c === 'Worldwide (Standard Multi-Tenant)'
      ? '商用マルチテナント (Worldwide)'
      : c,
  );
  return labels.join(' / ');
}

/**
 * Translate a `SuggestedChangeAction` into natural Japanese IT administrator
 * guidance naming the target Microsoft 365 workload, admin portal, Feature ID,
 * rollout schedule, and accountable owner role.
 */
export function translateSuggestedActionToJapanese(input: {
  readonly action: SuggestedChangeAction;
  readonly featureId: string;
  readonly products: readonly string[];
  readonly scheduleText: string;
  readonly ownerDisplay?: string;
}): string {
  const workload =
    input.products.length > 0
      ? input.products.join(' / ')
      : '対象 Microsoft 365 サービス';
  const portal = resolvePortalPhrase(input.products);
  const roleDisplay =
    input.ownerDisplay ??
    resolveOwnerDisplayForWorkload(
      undefined,
      input.products,
      input.action.ownerKey,
    );
  const kindLabel = ACTION_KIND_LABEL_JA[input.action.kind];
  const dueNote =
    input.action.dueAt !== undefined
      ? `（対応期限: ${input.action.dueAt.slice(0, 10)}）`
      : '';

  switch (input.action.kind) {
    case 'INVESTIGATE':
      return `**[${kindLabel}]** ${portal} で現行の ${workload} 設定と Feature ID ${input.featureId} の展開時期（${input.scheduleText}）を確認する（担当: ${roleDisplay}）${dueNote}`;
    case 'PLAN':
      return `**[${kindLabel}]** ${workload} の設定変更手順とメンテナンス窓口での適用計画を作成する（担当: ${roleDisplay}）${dueNote}`;
    case 'IMPLEMENT':
      return `**[${kindLabel}]** 計画に基づき ${portal} で ${workload} のポリシー設定を更新する（担当: ${roleDisplay}）${dueNote}`;
    case 'COMMUNICATE':
      return `**[${kindLabel}]** 影響を受ける部門および ${roleDisplay} へ変更内容と提供時期（${input.scheduleText}）を共有する${dueNote}`;
    case 'VALIDATE':
      return `**[${kindLabel}]** 提供開始後に ${portal} 上で意図したポリシー動作になっているか確認する（担当: ${roleDisplay}）${dueNote}`;
  }
}

/**
 * Synthesize 1-2 concrete, non-repetitive Japanese review points tailored to
 * the specific workload, portal, rollout timing, and active change signals.
 */
function buildTailoredCheckpointsJa(
  entry: DigestChangeEntry,
  meta: ZennItemMetadata,
  highestActionableState: 'ACTION_REQUIRED' | 'REVIEW_REQUIRED',
): string[] {
  const ev = entry.changeEvent;
  const portal = resolvePortalPhrase(meta.normalizedWorkloads);
  const workload = meta.normalizedWorkloads.join(' / ');
  const schedule = formatScheduleWindow(meta);
  const combinedLower = `${ev.title} ${ev.body}`.toLowerCase();
  const points: string[] = [];

  if (
    combinedLower.includes('quarantine') ||
    combinedLower.includes('threat explorer')
  ) {
    points.push(
      `**${portal} での検疫リリース権限確認**: Threat Explorer や Advanced Hunting から検疫メールを直接リリースできる運用導線に変わるため、SOC 担当者とメール管理者の RBAC 役割分担（${schedule}）を見直す。`,
    );
  } else if (
    combinedLower.includes('data loss prevention') ||
    combinedLower.includes('endpoint dlp')
  ) {
    points.push(
      `**${portal} の DLP 同期ステータス運用確認**: ポリシー変更後の同期状態表示 SLA が短縮されるため、既存の Endpoint DLP テスト手順およびポリシー配布待ち時間の運用基準（${schedule}）を更新する。`,
    );
  } else if (
    combinedLower.includes('auto-labeling') ||
    combinedLower.includes('sensitivity label')
  ) {
    points.push(
      `**${portal} の自動ラベル付け対象範囲の確認**: 既存の秘密度ラベル自動適用ルールや会議成果物・旧形式 Office ファイル（.doc / .xls / .ppt 等）への意図しないラベル付与が起きないか、プレビュー段階（${schedule}）でシミュレーションを実施する。`,
    );
  } else if (combinedLower.includes('communication compliance')) {
    points.push(
      `**${portal} のアラート通知先・頻度の棚卸し**: コミュニケーション コンプライアンスのアラート頻度や通知先メール設定のカスタマイズ拡張にあわせ、現行ポリシーの通知ノイズと監査担当者割当（${schedule}）を確認する。`,
    );
  } else if (
    combinedLower.includes('external') &&
    combinedLower.includes('bot')
  ) {
    points.push(
      `**${portal} での外部会議ボット接続方針の整理**: 社外製 AI 議事録ボット等の会議参加・検知レポート機能が追加されるため、匿名参加・外部アプリ許可ポリシーと監査レポートの確認フロー（${schedule}）を決めておく。`,
    );
  } else if (
    combinedLower.includes('copilot analytics') ||
    combinedLower.includes('viva')
  ) {
    points.push(
      `**${portal} の権限移行確認**: Viva Insights の Copilot Analytics アクセス管理が製品内の新ポリシー画面へ統合されるため、既存の管理ロール割当がシステム定義ポリシーへ想定どおり引き継がれるか（${schedule}）を確認する。`,
    );
  } else if (
    combinedLower.includes('finance and operations') ||
    combinedLower.includes('dataverse')
  ) {
    points.push(
      `**${portal} の特権ロール管理フロー確認**: Dataverse と財務・運用アプリのシステム管理者・セキュリティロール管理が一本化されるため、環境管理者の権限付与手順（${schedule}）を現行運用と照合する。`,
    );
  } else if (ev.signals?.isRetirementOrDeprecation === true) {
    points.push(
      `**廃止・非推奨機能への依存調査**: ${workload} の対象機能・旧 API を利用中のスクリプトや連携アプリがないか ${portal} で棚卸しし、後継方式への移行計画（${schedule}）を立てる。`,
    );
  } else {
    points.push(
      `**${portal} での事前設定確認**: ${workload} の現行テナント設定と照らし合わせ、既定値変更や管理メニュー追加に伴う運用手順の修正要否（${schedule}）を確認する。`,
    );
  }

  if (highestActionableState === 'ACTION_REQUIRED') {
    points.push(
      `**変更適用と動作検証**: セキュリティ制御に関わる変更のため、検証用グループで先行確認した上で本番ポリシーへ反映し、適用後の監査ログを確認する。`,
    );
  }

  return points;
}

function highestState(entry: DigestChangeEntry): ImpactState {
  let best: ImpactState = 'NOT_APPLICABLE';
  for (const outcome of entry.outcomes) {
    const state = outcome.analysisRecord.impactAssessment.state;
    if (STATE_PRIORITY[state] < STATE_PRIORITY[best]) {
      best = state;
    }
  }
  return best;
}

function findAbsentTenantServicePaths(outcome: DigestPersonaOutcome): string[] {
  const paths: string[] = [];
  for (const rec of outcome.analysisRecord.provenanceRecords) {
    if (
      rec.kind === 'tenant_fact' &&
      rec.observation.presence === 'absent' &&
      (rec.path.startsWith('services.') ||
        rec.path.startsWith('environment.') ||
        rec.path.startsWith('capabilities.'))
    ) {
      paths.push(rec.path);
    }
  }
  return paths;
}

function findConfirmedFalseTenantPaths(
  outcome: DigestPersonaOutcome,
): string[] {
  const paths: string[] = [];
  for (const rec of outcome.analysisRecord.provenanceRecords) {
    if (
      rec.kind === 'tenant_fact' &&
      rec.observation.presence === 'present' &&
      rec.observation.value === false &&
      (rec.path.startsWith('services.') ||
        rec.path.startsWith('environment.') ||
        rec.path.startsWith('capabilities.'))
    ) {
      paths.push(rec.path);
    }
  }
  return paths;
}

function describePersonaReasonCleanJa(
  outcome: DigestPersonaOutcome,
  entry: DigestChangeEntry,
  normalizedWorkloads: readonly string[],
): string {
  const assessment = outcome.analysisRecord.impactAssessment;
  const state = assessment.state;
  const workloadLabel = normalizedWorkloads.join(' / ');

  if (assessment.state === 'NOT_APPLICABLE') {
    const falsePaths = findConfirmedFalseTenantPaths(outcome);
    if (falsePaths.length > 0) {
      const names = falsePaths.map(humanizeProfilePath).join('・');
      return `${names}が未導入のため対象外`;
    }
    return '対象サービス未導入のため対象外';
  }
  if (assessment.state === 'INSUFFICIENT_CONTEXT') {
    if (
      assessment.missingContext !== undefined &&
      assessment.missingContext.length > 0
    ) {
      const names = assessment.missingContext
        .map(humanizeProfilePath)
        .join('・');
      return `${names}が未登録のため棚卸し待ち`;
    }
    if (
      assessment.missingMappings !== undefined &&
      assessment.missingMappings.length > 0
    ) {
      return `新設製品タグ（${assessment.missingMappings.map((m) => String(m.value)).join(', ')}）の適用定義待ち`;
    }
  }

  const absentPaths = findAbsentTenantServicePaths(outcome);
  const falsePaths = findConfirmedFalseTenantPaths(outcome);
  const hasSecurity = entry.changeEvent.signals?.hasSecurityImpact === true;
  const hasCompliance = entry.changeEvent.signals?.hasComplianceImpact === true;
  const hasRetirement =
    entry.changeEvent.signals?.isRetirementOrDeprecation === true;
  const hasAdmin = entry.changeEvent.signals?.hasAdminImpact === true;

  if (state === 'ACTION_REQUIRED' && hasSecurity) {
    if (falsePaths.length > 0) {
      return 'セキュリティ制御変更のため安全側で対応必須を維持';
    }
    return `${workloadLabel} のセキュリティ制御変更のため対応必須`;
  }
  if (state === 'REVIEW_REQUIRED') {
    if (absentPaths.length > 0 && (hasCompliance || hasRetirement)) {
      const names = absentPaths.map(humanizeProfilePath).join('・');
      return `${names}が未登録のため安全側で確認対象に分類`;
    }
    if (hasRetirement) {
      return `${workloadLabel} の廃止・非推奨を伴う変更のため確認対象`;
    }
    if (hasCompliance) {
      return `${workloadLabel} のコンプライアンス制御変更のため確認対象`;
    }
    if (hasAdmin) {
      return `${workloadLabel} の管理者向け制御・レポート変更のため確認対象`;
    }
  }
  return '事前設定不要な一般機能更新';
}

function renderFeatureSectionJa(
  entry: DigestChangeEntry,
  orderedPersonas: readonly DigestPersonaSummary[],
): string {
  const meta = extractItemMetadata(entry);
  const ev = entry.changeEvent;
  const topState = highestState(entry);
  const actionableTier: 'ACTION_REQUIRED' | 'REVIEW_REQUIRED' =
    topState === 'ACTION_REQUIRED' ? 'ACTION_REQUIRED' : 'REVIEW_REQUIRED';
  const lines: string[] = [];

  lines.push(
    `### Feature ID ${ev.externalId}: ${sanitizeHeadingTitle(ev.title)}`,
  );
  lines.push('');

  const learnLink =
    meta.moreInfoLink !== null
      ? ` / [Microsoft Learn](${meta.moreInfoLink})`
      : '';
  lines.push(
    `- **対象サービス / 状態**: ${meta.normalizedWorkloads.join('・')}（${formatStatusJa(meta.status)} / ${formatScheduleWindow(meta)} / [Roadmap #${ev.externalId}](${meta.roadmapUrl})${learnLink}）`,
  );
  lines.push(
    `- **展開クラウド / 更新日**: ${formatCloudSummaryJa(meta.cloudInstances)}（最終更新: ${ev.updatedAt.slice(0, 10)}）`,
  );
  lines.push('');

  const outcomeByPersona = new Map(entry.outcomes.map((o) => [o.personaId, o]));
  lines.push('| 組織ペルソナ | 判定 | 想定担当 | 判断の理由 |');
  lines.push('| --- | --- | --- | --- |');
  for (const personaSummary of orderedPersonas) {
    const outcome = outcomeByPersona.get(personaSummary.personaId);
    if (outcome === undefined) continue;
    const state = outcome.analysisRecord.impactAssessment.state;
    const ownerDisplay =
      state === 'ACTION_REQUIRED' || state === 'REVIEW_REQUIRED'
        ? resolveOwnerDisplayForWorkload(
            personaSummary,
            meta.normalizedWorkloads,
            outcome.suggestedChangeActionResult?.actions[0]?.ownerKey,
          )
        : '—';
    lines.push(
      `| ${escapeCell(formatPersonaLabel(personaSummary.personaId))} | **${STATE_LABEL_JA[state]}** | ${escapeCell(ownerDisplay)} | ${escapeCell(describePersonaReasonCleanJa(outcome, entry, meta.normalizedWorkloads))} |`,
    );
  }
  lines.push('');

  const checkpoints = buildTailoredCheckpointsJa(entry, meta, actionableTier);
  for (const point of checkpoints) {
    lines.push(`- ${point}`);
  }
  lines.push('');

  lines.push(':::details Microsoft 公開ロードマップ原文');
  lines.push(stripEmojis(ev.body));
  lines.push(':::');
  lines.push('');

  return lines.join('\n');
}

function informationalSortRank(status: string): number {
  switch (status) {
    case 'Rolling out':
      return 0;
    case 'In development':
      return 1;
    case 'Launched':
      return 2;
    case 'Cancelled':
      return 3;
    default:
      return 2;
  }
}

/**
 * Render a concise, reader-facing Zenn tech article (`zenn-article-ja.md`) from
 * a validated `DigestBundle`.
 */
export function renderZennArticleMarkdownJa(bundleInput: DigestBundle): string {
  const bundle = DigestBundleSchema.parse(bundleInput);
  const orderedPersonas = sortPersonasForDisplay(bundle.personas);
  const sinceSlash = formatDateSlash(bundle.window.since);
  const untilShort = formatDateShortMonthDay(bundle.window.until);

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
        STATE_PRIORITY[highestState(a)] - STATE_PRIORITY[highestState(b)];
      if (stateDiff !== 0) return stateDiff;
      return (
        Date.parse(b.changeEvent.updatedAt) -
        Date.parse(a.changeEvent.updatedAt)
      );
    });

  const sovereignExcludedEntries = bundle.entries.filter((entry) => {
    const meta = extractItemMetadata(entry);
    return (
      meta.sovereignCloudOnly &&
      entry.outcomes.every(
        (o) => o.analysisRecord.impactAssessment.state === 'NOT_APPLICABLE',
      )
    );
  });

  const title = `M365週次変更影響まとめ (${sinceSlash}-${untilShort}) 要確認${actionableEntries.length}件とGCC除外`;

  const lines: string[] = [];
  lines.push('---');
  lines.push(`title: '${title}'`);
  lines.push("emoji: '📡'");
  lines.push("type: 'tech'");
  lines.push(
    "topics: ['microsoft365', 'entraid', 'intune', 'purview', '情シス']",
  );
  lines.push('published: false');
  lines.push('---');
  lines.push('');

  lines.push(
    `Microsoft 365 公開ロードマップ（全 ${bundle.feedSource.fetchedItemCount.toLocaleString('en-US')} 件）から直近 ${bundle.window.days} 日間（${formatDateSlash(bundle.window.since)} 〜 ${formatDateSlash(bundle.window.until)}）に更新された上位 ${bundle.summary.changeCount} 件を取得し、日本の商用マルチテナント環境を想定した ${bundle.summary.personaCount} 種類の組織ペルソナで影響度を整理しました。`,
  );
  lines.push('');
  lines.push(
    `公開ロードマップには、国内の一般企業テナントには展開されない米国政府機関向けクラウド専用（GCC / GCC High / DoD）の更新や未契約の Dynamics 365 系アイテムが多く混在しています。今週分では対象 ${bundle.summary.changeCount} 件から米国政府クラウド専用 **${bundle.summary.sovereignCloudExcludedCount} 件**を自動除外し、商用テナントの情シス担当者が確認すべき **${actionableEntries.length} 件**を抽出しました。`,
  );
  lines.push('');

  // Section 1: Persona Comparison
  lines.push('## 組織規模別ペルソナの影響比較');
  lines.push('');
  lines.push(
    'Microsoft Intune や Microsoft Purview、Microsoft Viva の導入状況によって今週確認すべき件数は変わります。利用有無をまだ台帳化できていないサービスは、勝手に対象外へ倒さず「設定の棚卸し待ち」として分けて集計しています。',
  );
  lines.push('');
  lines.push(
    '| 組織ペルソナ | 想定構成の要点 | 対応必須 | 要確認 | 棚卸し待ち | 情報共有 | 対象外 |',
  );
  lines.push('| --- | --- | ---: | ---: | ---: | ---: | ---: |');
  for (const persona of orderedPersonas) {
    const meta = PERSONA_DISPLAY_META[persona.personaId];
    const summaryText = meta?.contextSummary ?? `版: ${persona.profileVersion}`;
    const sc = persona.stateCounts;
    lines.push(
      `| **${escapeCell(formatPersonaLabel(persona.personaId))}** | ${escapeCell(summaryText)} | ${sc.ACTION_REQUIRED} | ${sc.REVIEW_REQUIRED} | ${sc.INSUFFICIENT_CONTEXT} | ${sc.INFORMATIONAL} | ${sc.NOT_APPLICABLE} |`,
    );
  }
  lines.push('');

  // Section 2: Actionable & Review Required Features
  lines.push('## 商用テナントで要確認となる変更一覧');
  lines.push('');
  lines.push(
    '各機能の基本情報と折りたたみ内の原文は Microsoft 365 公開ロードマップの記録に基づき、判定表と確認ポイントはテナント構成プロファイルと決定論的ポリシーから算出した推奨事項です（Microsoft 公式の手順指示ではありません）。',
  );
  lines.push('');
  if (actionableEntries.length === 0) {
    lines.push(
      '今週のウィンドウ内で対応必須または要確認に該当する商用クラウド向け更新はありませんでした。',
    );
    lines.push('');
  } else {
    for (const entry of actionableEntries) {
      lines.push(renderFeatureSectionJa(entry, orderedPersonas));
    }
  }

  // Section 3: Insufficient Context Check Note
  const insufficientEntries = bundle.entries.filter((entry) =>
    entry.outcomes.some(
      (o) => o.analysisRecord.impactAssessment.state === 'INSUFFICIENT_CONTEXT',
    ),
  );

  lines.push('## 設定の棚卸し待ちとなった項目');
  lines.push('');
  if (insufficientEntries.length === 0) {
    lines.push('今週の対象変更で棚卸し待ちとなった項目はありません。');
    lines.push('');
  } else {
    lines.push(
      '以下の項目は、該当ペルソナでサービスの利用有無が未登録、または新設された製品タグが未定義のため保留とした変更です。自組織での利用実態を一度確認して有効・無効を確定させると、次週以降は要確認または対象外へ自動で振り分けられます。',
    );
    lines.push('');
    lines.push('| Feature ID | 状態 | タイトル | 確認が必要なペルソナと項目 |');
    lines.push('| --- | --- | --- | --- |');
    for (const entry of insufficientEntries) {
      const meta = extractItemMetadata(entry);
      const details: string[] = [];
      for (const persona of orderedPersonas) {
        const outcome = entry.outcomes.find(
          (o) => o.personaId === persona.personaId,
        );
        if (
          outcome === undefined ||
          outcome.analysisRecord.impactAssessment.state !==
            'INSUFFICIENT_CONTEXT'
        ) {
          continue;
        }
        const assessment = outcome.analysisRecord.impactAssessment;
        const missingParts: string[] = [];
        if (assessment.missingContext !== undefined) {
          missingParts.push(
            ...assessment.missingContext.map(humanizeProfilePath),
          );
        }
        if (assessment.missingMappings !== undefined) {
          missingParts.push(
            ...assessment.missingMappings.map(
              (m) => `新設タグ (${String(m.value)})`,
            ),
          );
        }
        const shortName =
          PERSONA_DISPLAY_META[persona.personaId]?.shortLabel ??
          persona.personaId;
        details.push(`${shortName}: ${missingParts.join('・')}`);
      }
      lines.push(
        `| [#${escapeCell(entry.changeEvent.externalId)}](${meta.roadmapUrl}) | ${escapeCell(formatStatusJa(meta.status))} | ${escapeCell(entry.changeEvent.title)} | ${details.map(escapeCell).join('<br>')} |`,
      );
    }
    lines.push('');
  }

  // Section 4: Sovereign Cloud Excluded Summary
  lines.push('## 米国政府クラウド専用として除外した更新');
  lines.push('');
  if (sovereignExcludedEntries.length === 0) {
    lines.push(
      '今週のウィンドウ内にソブリンクラウド専用の更新は含まれていませんでした。',
    );
    lines.push('');
  } else {
    lines.push(
      `以下の ${sovereignExcludedEntries.length} 件は Microsoft Purview や Power Platform などの製品名を含みますが、展開先クラウドに商用マルチテナント（Worldwide）が含まれないため対象外として除外しました。`,
    );
    lines.push('');
    lines.push('| Feature ID | 展開先クラウド | 対象製品 | タイトル |');
    lines.push('| --- | --- | --- | --- |');
    for (const entry of sovereignExcludedEntries) {
      const meta = extractItemMetadata(entry);
      lines.push(
        `| [#${escapeCell(entry.changeEvent.externalId)}](${meta.roadmapUrl}) | ${escapeCell(meta.cloudInstances.join(', '))} | ${escapeCell(meta.normalizedWorkloads.join(', '))} | ${escapeCell(entry.changeEvent.title)} |`,
      );
    }
    lines.push('');
  }

  // Section 5: Compact Top-10 Informational Highlights
  const allInformationalEntries = bundle.entries
    .filter(
      (entry) =>
        !actionableEntries.includes(entry) &&
        entry.outcomes.some(
          (o) => o.analysisRecord.impactAssessment.state === 'INFORMATIONAL',
        ),
    )
    .sort((a, b) => {
      const rankDiff =
        informationalSortRank(extractItemMetadata(a).status) -
        informationalSortRank(extractItemMetadata(b).status);
      if (rankDiff !== 0) return rankDiff;
      return (
        Date.parse(b.changeEvent.updatedAt) -
        Date.parse(a.changeEvent.updatedAt)
      );
    });

  const shownInformational = allInformationalEntries.slice(
    0,
    MAX_INFORMATIONAL_ROWS,
  );
  const omittedInformationalCount =
    allInformationalEntries.length - shownInformational.length;

  lines.push('## 管理者作業を伴わない主な機能追加');
  lines.push('');
  if (shownInformational.length === 0) {
    lines.push('該当する一般機能更新はありません。');
    lines.push('');
  } else {
    lines.push(
      '事前のポリシー変更を必須としないエンドユーザー向け改善の抜粋です。社内ポータルやヘルプデスク向けの案内材料として参照してください。',
    );
    lines.push('');
    lines.push('| Feature ID | 提供予定 (GA) | 状態 | 製品 | タイトル |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const entry of shownInformational) {
      const meta = extractItemMetadata(entry);
      lines.push(
        `| [#${escapeCell(entry.changeEvent.externalId)}](${meta.roadmapUrl}) | ${escapeCell(meta.gaDate ?? '未定')} | ${escapeCell(formatStatusJa(meta.status))} | ${escapeCell(meta.normalizedWorkloads.join(', '))} | ${escapeCell(entry.changeEvent.title)} |`,
      );
    }
    lines.push('');
    if (omittedInformationalCount > 0) {
      lines.push(
        `ほか ${omittedInformationalCount} 件の一般機能更新・計画変更も情報共有または対象外として集計済みです。`,
      );
      lines.push('');
    }
  }

  // Section 6: Accurate Methodology Note (no premature public-OSS claim)
  lines.push('## 評価方法について');
  lines.push('');
  lines.push(
    `本記事の集計は、Microsoft 365 公開ロードマップ JSON API（更新基準日時: ${bundle.generatedAt.slice(0, 10)}）の取得データを、3 種類の合成テナント構成プロファイルおよび決定論的リスク・適用性ポリシー（\`${bundle.policyVersions.riskPolicyRulesVersion}\` / \`${bundle.policyVersions.tenantApplicabilityPolicyRulesVersion}\`）と照合して自動生成しています。外部 LLM API を介さないため、同一スナップショットと同一プロファイルからは常に同じ判定結果が再現されます。`,
  );

  return `${lines.join('\n')}\n`;
}
