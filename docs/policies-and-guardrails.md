# 決定論的リスクポリシーとテナント適用性評価

M365 Change Radar は、外部モデルやヒューリスティック分類より前に 2 つの有界 DSL（リスクポリシーとテナント適用性ポリシー）を決定論的に評価します。

## 1. リスクポリシーと高リスク下限ガードレール

`evaluateRiskPolicy(policy, changeEvent)`（`src/domain/risk-policy-evaluator.ts`）は、正規化済みの `ChangeEvent.severity` と `ChangeEvent.signals` のみを検査し、`ACTION_REQUIRED` または `REVIEW_REQUIRED` の下限（`finalStateFloor`）を算出します。

### 条件プリミティブと不明時フォールバック

- **条件種別**: `boolean_signal`、`severity_at_least`（`high` / `critical`）、`admin_action_deadline_present`、`normalized_tag`、および最大 8 個の原子条件を束ねる 1 階層の `all_of` / `any_of`。
- **三値評価 (`MATCH` / `NO_MATCH` / `UNKNOWN`)**:
  - `all_of`: 1 つでも `NO_MATCH` があれば `NO_MATCH`、なければ `UNKNOWN` があれば `UNKNOWN`、すべて一致で `MATCH`。
  - `any_of`: 1 つでも `MATCH` があれば `MATCH`、なければ `UNKNOWN` があれば `UNKNOWN`、すべて不一致で `NO_MATCH`。
- **安全側フォールバック (`unknownHandling: "REVIEW_REQUIRED"`)**: 有効なルールが `UNKNOWN` となった場合、見逃しを防ぐため `REVIEW_REQUIRED` 下限を付与する。ソース側で不在が確認されたシグナルは `false` / `null` / `[]` として渡されるため `NO_MATCH` となり、不要な `UNKNOWN` エスカレーションは発生しない。

### 本番リスクポリシー (`policies/risk-policy.json`)

| ルール ID                      | 発火条件                                                                      | 確定する下限 (`stateFloor`) |
| ------------------------------ | ----------------------------------------------------------------------------- | --------------------------- |
| `major-change`                 | `signals.isMajorChange === true`                                              | `REVIEW_REQUIRED`           |
| `admin-action-deadline`        | `signals.actionRequiredBy` に日時が存在                                       | `ACTION_REQUIRED`           |
| `high-or-critical-severity`    | `severity` が `high` または `critical`                                        | `REVIEW_REQUIRED`           |
| `admin-impact-and-severity`    | `hasAdminImpact === true` かつ `severity >= high`                             | `ACTION_REQUIRED`           |
| `retirement-or-deprecation`    | `isRetirementOrDeprecation === true` または `retirement` / `deprecation` タグ | `REVIEW_REQUIRED`           |
| `security-impact`              | `hasSecurityImpact === true` または `security` タグ                           | `ACTION_REQUIRED`           |
| `privacy-or-compliance-impact` | `hasPrivacyImpact` / `hasComplianceImpact === true` または該当タグ            | `REVIEW_REQUIRED`           |

## 2. テナント適用性評価 (`Unknown != Not Applicable`)

`evaluateTenantApplicability(policy, changeEvent, tenantProfile)`（`src/domain/tenant-applicability-evaluator.ts`）は、変更イベントが対象テナントに関係するかを判定します。

### セレクターと判定優先順位

各ルールは `ChangeEvent.products` または `ChangeEvent.categories` に対する大文字小文字区別ありの完全一致セレクター（1〜8 個の値）と、`TenantProfile` の `services` / `environment` / `capabilities` を参照する `all_of` / `any_of` 条件グループを持ちます。

最終ステータスは以下の排他的優先順位で決定されます。

1. **`APPLICABLE`**: セレクターが一致した有効ルールのうち、少なくとも 1 つの条件グループが `MATCH` となった場合（別フィールドに未定義タグがあれば `mappingWarnings` に保持）。
2. **`INSUFFICIENT_CONTEXT`**: `APPLICABLE` が成立せず、セレクター一致ルール内に未記入キー（`UNKNOWN`）が存在する場合（`missingContext` に記録）、または有効セレクターが参照するフィールドにポリシー未定義の値・空配列が存在する場合（`missingMappings` に記録）。
3. **`NOT_APPLICABLE`**: 1 つ以上のセレクター一致ルールが存在し、それらすべての条件グループが明示的な `false` 等により `NO_MATCH` と確定した場合。

どのセレクターにも一致しない未知の製品タグ（例: `Work IQ`）は、`NOT_APPLICABLE` ではなく `missingMappings` 付きの `INSUFFICIENT_CONTEXT` となります。

## 3. 決定論的判定とガードレールマージ

`createDeterministicImpactDecision(riskEvaluation, tenantApplicability)` は以下の順序で下流経路を選択します。

| 判定種別 (`kind`)         | 条件                                                                      | 下流の挙動                                                              |
| ------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `GUARDRAIL_FLOOR`         | `finalStateFloor !== null`                                                | 分類器の提案が下限未満なら `GUARDRAIL_RAISED` で下限状態へ引き上げ      |
| `CLASSIFICATION_REQUIRED` | `finalStateFloor === null` かつ `APPLICABLE`                              | 分類器の提案を `CLASSIFIER_ACCEPTED` として採用                         |
| `DETERMINISTIC_FINAL`     | `finalStateFloor === null` かつ `NOT_APPLICABLE` / `INSUFFICIENT_CONTEXT` | 分類器を呼ばず（`ai.used = false`）テナント判定をそのまま最終状態とする |

既定の週次ダイジェスト（`pnpm digest`）では、外部 LLM を呼ばない決定論的ルール分類器（`createRoadmapRuleClassifier`）を注入し、`APPLICABLE` かつ `signals.hasAdminImpact === true`（プロファイル側で `adminImpactRequiresReview !== false`）の変更を `REVIEW_REQUIRED`、それ以外の一般機能追加を `INFORMATIONAL` と提案します。

## 4. ソブリンクラウド専用更新の自動除外設計

Microsoft 365 公開ロードマップには、一般企業の商用マルチテナント（`Worldwide (Standard Multi-Tenant)`）には展開されない米国政府機関向け（`GCC`, `GCC High`, `DoD`）や中国（`China (21Vianet)`）専用のアイテムが含まれます。

1. **アダプタ正規化**: `cloudInstances` が非空かつ `Worldwide (Standard Multi-Tenant)` を含まない場合のみ、`ChangeEvent.products` をソブリンクラウド識別子（`Microsoft Cloud GCC`, `Microsoft Cloud GCC High`, `Microsoft Cloud DoD`, `Microsoft Cloud China (21Vianet)`）へ正規化する。
2. **プロファイル宣言**: 日本企業向け参照プロファイル（`profiles/*.json`）は `environment.cloud_worldwide_multi_tenant: true` とともに `cloud_gcc: false`, `cloud_gcc_high: false`, `cloud_dod: false`, `cloud_china_21vianet: false` を明示する。
3. **物理クラウド境界での下限抑止**: `resolveEffectiveRiskPolicyForCloudPartition` は、一致したすべてのルールが `environment.cloud_* === false` によって `NOT_APPLICABLE` と確定した場合に限り、商用テナント向けリスク下限ルールを無効化して `DETERMINISTIC_FINAL` -> `NOT_APPLICABLE`（`ai.used = false`）へ到達させる。
4. **安全側の維持**:
   - `["Worldwide (Standard Multi-Tenant)", "GCC"]` のような商用・政府併記アイテム、および `cloudInstances` が空のアイテムは通常の製品適用性評価を行う。
   - プロファイル側で `environment.cloud_gcc` 等が省略されている場合は `INSUFFICIENT_CONTEXT` となり、勝手に除外しない。
   - 同一クラウド内でのサービス未導入（例: `services.viva = false`）に対してはリスクガードレール抑止を行わず、Phase 1 の安全不変条件を維持する。
