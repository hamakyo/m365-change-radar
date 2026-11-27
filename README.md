# M365 Change Radar

Microsoft 365 の変更情報と組織ごとの宣言的プロファイル（`TenantProfile`）を突き合わせ、5 段階の影響度と運用チェックリストを出力する変更影響評価エンジンです。
汎用的な Message Center 要約ツールではなく、自組織の利用サービス・クラウド環境・運用ポリシーに基づいた判断と証跡管理を目的としています。
決定論的なリスクガードレールを先に適用するため、重大変更や廃止・セキュリティ変更が分類器によって「情報共有」や「対象外」へ格下げされることはありません。

## クイックスタート

**動作要件**: Node.js 22 以上、`pnpm@9.15.4`

```sh
pnpm install --frozen-lockfile

# Microsoft 365 公開ロードマップから直近 7 日間のダイジェストを生成
# （Microsoft Entra 管理者同意不要・外部 LLM API 呼び出し 0 回・API 費用 $0）
pnpm digest --live --days 7 --limit 50 --profiles profiles --out-dir artifacts/digest

# ローカルスナップショット（JSON または RSS 2.0 XML）からの決定論的オフライン実行
pnpm digest --input test/fixtures/microsoft-roadmap-snapshot.json --days 14 --out-dir artifacts/digest
```

実行すると `--out-dir` 配下に次の 3 ファイルを出力します。

- `digest-bundle.json`: 正規化済み `ChangeEvent`、版情報、`AnalysisRecord`、推奨アクションを含む検証済み JSON バンドル
- `digest-ja.md`: ソース事実・テナント事実・ポリシー結論・証跡 ID を保持した技術監査台帳
- `zenn-article-ja.md`: 組織規模別の影響比較と確認ポイントを整理した Zenn 技術記事ドラフト

## 処理パイプラインと 5 つの判定状態

```text
Microsoft 365 公開ロードマップ (JSON API / RSS)
  -> MicrosoftRoadmapAdapter (ChangeEvent + 不変 sourceMessageVersion)
  -> RiskPolicy 評価 (高リスク下限ガードレール) + TenantApplicability 評価
  -> createImpactAnalysisRecord (決定論的判定 + 分類マージ)
  -> AnalysisRecord + SuggestedChangeActionResult
  -> digest-bundle.json / digest-ja.md / zenn-article-ja.md
```

各変更 × テナントプロファイルの組み合わせは、互いに排他的な 5 状態のいずれかに分類されます。

| 判定状態               | 意味と運用上の扱い                                                          | アクション生成                         |
| ---------------------- | --------------------------------------------------------------------------- | -------------------------------------- |
| `ACTION_REQUIRED`      | 管理者対応期限やセキュリティ制御変更など計画・設定変更が必須                | 5 段階（調査・計画・実装・周知・検証） |
| `REVIEW_REQUIRED`      | 重大変更・廃止・コンプライアンス変更・管理者設定変更など確認が必要          | 3 段階（調査・周知・検証）             |
| `INSUFFICIENT_CONTEXT` | プロファイルの該当キー未記入または製品タグ未定義のため保留                  | 生成しない（要棚卸し項目として明示）   |
| `INFORMATIONAL`        | 導入済みサービスへの一般機能追加など事前設定不要な変更                      | 生成しない                             |
| `NOT_APPLICABLE`       | 対象サービス未導入（`false`）または対象外ソブリンクラウド専用と確定した変更 | 生成しない                             |

**設計原則 (`Unknown != Not Applicable`)**: `TenantProfile` 上で未記入（省略）のフラグは「未導入（`false`）」ではなく「不明（`UNKNOWN`）」として扱い、勝手に `NOT_APPLICABLE` へ丸めず `INSUFFICIENT_CONTEXT` として可視化します。

## ディレクトリ構成

| パス                              | 役割                                                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `src/domain/`                     | コアドメインスキーマ（Zod）、リスク評価器、テナント適用性評価器、証跡・アクション生成ランナー                |
| `src/adapters/microsoft-roadmap/` | Microsoft 365 公開ロードマップ（JSON API / RSS 2.0）正規化アダプタ                                           |
| `src/digest/`                     | 週次ダイジェスト実行パイプライン、監査台帳レンダラー、Zenn 記事レンダラー                                    |
| `src/providers/`                  | OpenAI Responses API（`gpt-5.4-mini` Structured Outputs）分類器アダプタ（手動検証用）                        |
| `src/corpus/`                     | 合成ゴールデンコーパス検証器・評価ハーネス（50 変更 × 10 プロファイル / 65 ラベル）                          |
| `policies/`                       | 本番用リスクポリシー（`risk-policy.json`）およびテナント適用性ポリシー（`tenant-applicability-policy.json`） |
| `profiles/`                       | 日本企業向け参照テナントプロファイル 3 種（40 名最小構成 / 150 名 BP 標準構成 / 600 名 Hybrid E3 構成）      |
| `.github/workflows/`              | CI 品質ゲート（`ci.yml`）および週次ダイジェスト自動生成ワークフロー（`weekly-digest.yml`）                   |

## 主要コマンド一覧

| コマンド                 | 内容                                                                                | 外部通信 / API 費用                        |
| ------------------------ | ----------------------------------------------------------------------------------- | ------------------------------------------ |
| `pnpm lint`              | ESLint による静的解析                                                               | なし / `$0`                                |
| `pnpm format:check`      | Prettier によるフォーマット検証                                                     | なし / `$0`                                |
| `pnpm typecheck`         | TypeScript (`tsc --noEmit`) 厳格型検査                                              | なし / `$0`                                |
| `pnpm test`              | Vitest ユニット・CLI 結合テスト一式                                                 | なし / `$0`                                |
| `pnpm corpus:validate`   | ゴールデンコーパス・参照プロファイル・本番ポリシーの整合検証                        | なし / `$0`                                |
| `pnpm analyze`           | 合成コーパス 500 ペアの決定論的スモーク分析                                         | なし / `$0`                                |
| `pnpm phase1:report`     | Phase 1 品質ゲート達成状況レポート出力                                              | なし / `$0`                                |
| `pnpm digest`            | 公開ロードマップからのペルソナ別ダイジェスト生成（`--input` / `--live`）            | `--live` 時のみ公開 RSS/JSON 取得 / `$0`   |
| `pnpm provider:validate` | OpenAI Responses API による 65 ケース構造化出力検証（`.env.local` 必須・CI 非実行） | OpenAI API 通信あり / 有料（手動検証専用） |

## ドキュメント案内

詳細な設計仕様と検証記録は [`docs/README.md`](docs/README.md) に整理しています。

- [`docs/architecture.md`](docs/architecture.md) — ドメイン契約、証跡モデル、不変バージョン管理、アクション生成境界
- [`docs/policies-and-guardrails.md`](docs/policies-and-guardrails.md) — リスクポリシー DSL、テナント適用性評価、ソブリンクラウド除外設計
- [`docs/microsoft-roadmap-adapter.md`](docs/microsoft-roadmap-adapter.md) — Microsoft 365 公開ロードマップアダプタと正規化マッピング仕様
- [`docs/evaluation.md`](docs/evaluation.md) — ゴールデンコーパス構成と 2026-08-29 OpenAI 構造化出力検証結果
- [`AGENTS.md`](AGENTS.md) — 開発者・コーディングエージェント向け設計境界および品質規約

## ライセンス

[MIT License](LICENSE)
