# ドメイン契約と全体アーキテクチャ

M365 Change Radar のコアエンジン（`src/domain/`）は、データ取得元や分類プロバイダから独立した Zod スキーマ群と純粋関数群で構成されています。すべての公開型は Zod スキーマから推論（`z.infer`）され、`src/index.ts` から再エクスポートされます。

## 1. 入力契約: `ChangeEvent` と `TenantProfile`

### `ChangeEvent` (`src/domain/change-event.ts`)

外部フィード（Microsoft 365 公開ロードマップや将来の Microsoft Graph Message Center）を正規化したソース中立レコードです。

- **識別・本文・時刻**: `source`, `externalId`, `title`, `body`, オフセット付き ISO 8601 の `publishedAt` / `updatedAt`（`updatedAt >= publishedAt` を検証）。
- **正規化ラベル**: `products: string[]`, `categories: string[]`。適用性ポリシーはこの正規化配列のみを参照する。
- **不在と不明の区別 (`severity` / `signals`)**:
  - アダプタがソースを検査して「該当なし」と確認した場合は `false`（真偽値）、`null`（`severity`, `signals.actionRequiredBy`）、`[]`（`signals.tags`）を明示する。
  - ソース未検査または判定不能な場合のみプロパティ自体を省略し、下流の評価器に `UNKNOWN` として伝える。
- **監査用メタデータ (`sourceMetadata`)**: `JsonValueSchema` で検証された任意の JSON 値を保持する。`src/domain/` 内のポリシー評価器は `sourceMetadata` を一切参照しない。

### `TenantProfile` (`src/domain/tenant-profile.ts`)

組織の利用サービスや運用方針を記述する宣言的 JSON ファイルです。

- **必須 7 セクション**: `organization`, `services`, `environment`, `capabilities`, `ownership`, `changePolicy`, `maintenance` に加え、`schemaVersion`（例: `"1.0"`）と不透明な版識別子 `profileVersion` を持つ。
- **三値評価の対象**: `evaluateTenantApplicability` が参照できるのは `services`, `environment`, `capabilities` の 3 セクション内の真偽値フラグのみ。キーの省略は `UNKNOWN` を意味し、既定値で `false` に補完されることはない。

## 2. 出力契約: `ImpactAssessment` と `AnalysisRecord`

### 5 段階の `ImpactAssessment` (`src/domain/impact-assessment.ts`)

`state` を判別キーとする厳格な共用体です。

| `state`                | 必須フィールド                                                              | 備考                                                     |
| ---------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------- |
| `ACTION_REQUIRED`      | `reason`, 非空の `evidence: EvidenceId[]`                                   | 対応計画・設定変更が必須                                 |
| `REVIEW_REQUIRED`      | `reason`, 非空の `evidence: EvidenceId[]`                                   | 管理者による影響確認が必要                               |
| `INFORMATIONAL`        | `reason`, 非空の `evidence: EvidenceId[]`                                   | 事前設定不要な情報共有                                   |
| `NOT_APPLICABLE`       | `reason`, 非空の `evidence: EvidenceId[]`                                   | 導入状況またはクラウド境界により対象外と確定             |
| `INSUFFICIENT_CONTEXT` | `reason`, および `missingContext` または `missingMappings` の少なくとも一方 | 証跡 `evidence` 配列は持たず、不足パス・未定義タグを保持 |

`missingMappings` は `{ field: "products" | "categories", value: string | null }` 形式でポリシー未定義ラベル（または空配列センチネル `null`）を欠損なく保持します。

### 4 種別の証跡 `ProvenanceRecord` (`src/domain/provenance.ts`)

1 つの `AnalysisRecord` 内で一意な `evidenceId` を持つ 4 種別の判別共用体です。

1. `source_fact`: `ChangeEvent` 上のフィールドパスと観測結果 `FactObservation`（`{ presence: "present", value }` または `{ presence: "absent" }`）。
2. `tenant_fact`: `TenantProfile` 上のフィールドパスと `FactObservation`（`null` とプロパティ未定義 `absent` を JSON 往復後も厳密に区別）。
3. `deterministic_conclusion`: 所有ポリシー種別（`risk_policy` または `tenant_applicability_policy`）、ポリシー版、ルール ID、結論テキスト、依存 `dependsOnEvidenceIds`。
4. `ai_inference`: `promptVersion`, `model`, `modelVersion`, `confidence`（`0..1`、`-0` は拒否）、推論理由、依存 `dependsOnEvidenceIds`。構造化分類経由のレコード（`StructuredClassificationAIInferenceSchema`）は生の提案 `classificationOutput` を必須保持し、`confidence`・理由・依存 ID 順序の一致を検証する。

### `VersionBundle` と `AnalysisRecord` (`src/domain/analysis-record.ts`)

`AnalysisRecordSchema` は以下の整合性を単一スキーマで検証します。

- すべての参照 `evidenceId` および `dependsOnEvidenceIds` が同一レコード内に実在し重複がないこと。
- `sourceMessageVersion`、`tenantProfileVersion`、`riskPolicyRulesVersion`、`tenantApplicabilityPolicyRulesVersion` が各証跡レコードの版と完全一致すること。
- `versionBundle.ai` と `ai_inference` レコードが双方向整合すること（`used: false` なら AI 証跡 0 件、`used: true` なら 1 件以上かつモデル・プロンプト版が一致）。

## 3. 推奨チェックリスト契約 (`SuggestedChangeActionResult`)

`src/domain/suggested-change-action.ts` は人間向けの非自動実行タスクリストを定義します。

- **対象ゲート**: `ACTION_REQUIRED` または `REVIEW_REQUIRED` の `AnalysisRecord` のみ受理し、他の 3 状態は拒否する。
- **5 つのアクション種別**: `INVESTIGATE`, `PLAN`, `IMPLEMENT`, `COMMUNICATE`, `VALIDATE`。
- **生成起源の分離**:
  - `origin: "deterministic"`: `confidence` プロパティを一切持たず、`ai_inference` 証跡を参照できない。既定ジェネレータ（`createDeterministicSuggestedActionOutput`）は `ACTION_REQUIRED` に 5 種別すべて、`REVIEW_REQUIRED` に `INVESTIGATE` / `COMMUNICATE` / `VALIDATE` の 3 種別を固定順で出力する。
  - `origin: "ai_inference"`: `0..1`（`-0` 除外）の `confidence` を必須とし、少なくとも 1 つの `ai_inference` 証跡を参照する。

## 4. オーケストレーション境界と純粋性

- **`createImpactAnalysisRecord` (`src/domain/impact-analysis-runner.ts`)**: 入力スキーマ検証後、リスク評価と適用性評価を実行する。`DETERMINISTIC_FINAL` の場合は分類器を 0 回呼び出して `ai: { used: false }` のレコードを返し、それ以外の場合は JSON クローンした要求オブジェクトを注入済み `StructuredImpactClassifier` に 1 回だけ渡してガードレールマージを行う。
- **`generateSuggestedChangeActionResult` (`src/domain/suggested-action-generation-runner.ts`)**: 検証済み要求のクローンを `SuggestedChangeActionGenerator` に渡し、返却結果の証跡整合・ID 一意性・`undefined` 不在を再検証する。
- **純粋性保証**: `src/domain/` 内のいかなるモジュールも `Date.now()`、`crypto.randomUUID()`、ファイルシステム、ネットワークを呼び出さず、入力オブジェクトを破壊しない。
