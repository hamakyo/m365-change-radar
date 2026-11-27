# ドキュメント索引

`docs/` には M365 Change Radar の設計仕様、ポリシー評価規則、外部フィード正規化境界、およびゴールデンコーパス検証記録を 5 つの文書に集約しています。

## 文書一覧

| ドキュメント                                                   | 主な内容                                                                                                                                                                     | 対応モジュール                             |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| [`architecture.md`](architecture.md)                           | コアドメインスキーマ（`ChangeEvent`, `TenantProfile`, `ImpactAssessment`）、4 種別証跡（`ProvenanceRecord`）、不変 `VersionBundle`、推奨アクション生成契約と純粋関数ランナー | `src/domain/`                              |
| [`policies-and-guardrails.md`](policies-and-guardrails.md)     | 決定論的リスクポリシー DSL、テナント適用性評価の三値論理（`Unknown != Not Applicable`）、ガードレール統合、ソブリンクラウド（`GCC`/`DoD` 等）除外設計                        | `src/domain/`, `policies/`, `src/digest/`  |
| [`microsoft-roadmap-adapter.md`](microsoft-roadmap-adapter.md) | Microsoft 365 公開ロードマップ（JSON API / RSS 2.0 XML）取得・タイムアウト再試行、製品・クラウドマッピング表、保守的シグナル抽出、`roadmap-v1` 版算出                        | `src/adapters/microsoft-roadmap/`          |
| [`evaluation.md`](evaluation.md)                               | 合成ゴールデンコーパス（50 変更 × 10 プロファイル / 65 ラベル）、評価ハーネス指標、および 2026-08-29 OpenAI Structured Outputs（`gpt-5.4-mini`）検証結果                     | `src/corpus/`, `src/providers/`, `corpus/` |

## 読む順序の目安

1. **リポジトリ全体の使い方とコマンドを確認したい場合**: ルートの [`../README.md`](../README.md) を参照してください。
2. **自社テナント向けのプロファイルやポリシーを調整したい場合**: [`policies-and-guardrails.md`](policies-and-guardrails.md) と [`microsoft-roadmap-adapter.md`](microsoft-roadmap-adapter.md) のマッピング表を参照してください。
3. **スキーマ追加やコード変更を行う場合**: ルートの [`../AGENTS.md`](../AGENTS.md) で不変条件を確認した上で [`architecture.md`](architecture.md) を参照してください。
