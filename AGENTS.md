# AGENTS.md

M365 Change Radar を変更・拡張するコントリビューターおよびコーディングエージェント向けの設計境界と品質規約です。

## コア不変条件

1. **ソース中立なドメイン境界 (`ChangeEvent`)**:
   - すべての外部フィード取り込みは `{ changeEvent: ChangeEvent, sourceMessageVersion: string }` で終端させる。
   - `src/domain/` 内の評価器・ビルダーは `sourceMetadata` や Microsoft Graph / Roadmap 固有のワイヤーフィールドを直接参照しない。
2. **不明と対象外の厳格分離 (`INSUFFICIENT_CONTEXT` vs `NOT_APPLICABLE`)**:
   - `ChangeEvent.signals` や `TenantProfile`（`services`, `environment`, `capabilities`）で省略されたキーは `UNKNOWN` であり、`false` とみなさない。
   - ソースまたはプロファイルを確認した上での不在のみ `false` / `null` / `[]` として明示する。
   - ポリシー未定義の製品・カテゴリ値は `missingMappings` として保持し、他の一致ルールで `APPLICABLE` が成立しない限り `INSUFFICIENT_CONTEXT` とする。
3. **決定論的リスクガードレールの優先**:
   - `evaluateRiskPolicy` は分類器より先に実行され、高リスク条件一致時または必須シグナル不明時に `ACTION_REQUIRED` / `REVIEW_REQUIRED` の下限（`stateFloor`）を確定する。
   - `createStructuredImpactClassificationMergeResult` は下限未満の提案を常に `GUARDRAIL_RAISED` で引き上げる。
4. **証跡（Provenance）の所有権分離**:
   - `ProvenanceRecordSchema` は `source_fact`、`tenant_fact`、`deterministic_conclusion`（`risk_policy` / `tenant_applicability_policy`）、`ai_inference` の 4 種別を厳格に区別する。
   - 決定論的アクション（`origin: "deterministic"`）は `confidence` キーを持たず、`ai_inference` レコードを参照しない。
5. **不変バージョン束縛 (`VersionBundle`)**:
   - すべての `AnalysisRecord` は `sourceMessageVersion`、`tenantProfileVersion`、`riskPolicyRulesVersion`、`tenantApplicabilityPolicyRulesVersion`、および双方向整合する `ai` 使用有無を記録する。
   - 上流ソースのいかなる変更も異なる `sourceMessageVersion` を生成しなければならない。
6. **純粋関数境界と `undefined` 禁止の JSON 往復保証**:
   - `src/domain/` 内の関数はシステム時刻取得・UUID 生成・ファイル I/O・ネットワーク通信を一切行わない。
   - 受理されるすべてのドメインオブジェクトは任意の深さで値 `undefined` の独自プロパティを持たず、`JSON.parse(JSON.stringify(value))` と完全一致する。

## 品質ゲートと検証コマンド

Node.js 22 以上および `pnpm@9.15.4` で以下の全ゲートを通過させること。

```sh
pnpm lint              # ESLint 静的解析
pnpm format:check      # Prettier フォーマット検査
pnpm typecheck         # TypeScript 厳格型検査 (tsc --noEmit)
pnpm test              # Vitest オフライン単体・CLI 結合テスト
pnpm corpus:validate   # ゴールデンコーパス・参照プロファイル・本番ポリシー検証
pnpm analyze           # 合成 500 ペアの決定論的スモーク実行 ($0)
pnpm digest --input test/fixtures/microsoft-roadmap-snapshot.json --days 14 --out-dir artifacts/digest
```

`pnpm provider:validate` は有料の OpenAI Responses API（`gpt-5.4-mini`）を呼び出すため、CI や自動テストでは実行せず、手動検証時のみ使用する。

## 運用・セキュリティ規約

- **既定 `$0` 実行**: 通常開発・単体テスト・CI・定期 GitHub Actions はすべて外部有料 API を使わない決定論的パスで実行する。
- **生成物の直接編集禁止**: `digest-bundle.json`、`digest-ja.md`、`zenn-article-ja.md` などの生成出力を手作業で書き換えない。スキーマ・ポリシー・プロファイル・アダプタ・レンダラーを修正して再生成する。
- **機密情報・実在組織情報の排除**: API キー、トークン、テナント ID、社内ドメイン、個人情報をリポジトリに含めない。`profiles/` や `corpus/` は 100% 合成ペルソナを維持する。

## ドキュメント・レポート作成規約

- **見出しと表記**:
  - 見出し（`#`〜`####`）および本文に絵文字を使用しない（Zenn 記事フロントマターの `emoji:` キーのみ例外）。
  - 見出しの主語と述語の間に読点（`、`）を入れず、簡潔な体言止めにする。
- **証跡と固有名詞の明示**:
  - 固有名詞を欠いた抽象的な説明文を書かない。具体的な製品名（`Microsoft Teams`, `Microsoft Purview`, `Microsoft Intune` 等）、Feature ID、管理センター名、スキーマ・ルール ID を明記する。
  - Microsoft の公開ソース事実（`source_fact`）と、M365 Change Radar 側のポリシー評価・推奨チェックリストを視覚的・構造的に分離し、推奨事項を Microsoft 公式の手順指示のように記述しない。
