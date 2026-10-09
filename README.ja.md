# PocketChest

[English](README.md) | [繁體中文](README.zh-Hant.md) | [日本語](README.ja.md)

> ファイルとテキストを共有する、自分で運用するプライベートな仕組み。Cloudflare Worker 1 つと R2 バケット 1 つだけで、データベースは不要です。

## 🚀 すぐにデプロイ

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/lpyedge/PocketChest)

**ワンクリックデプロイ** · [デプロイガイド](DEPLOYMENT.ja.md) · [手動デプロイ](DEPLOYMENT.ja.md#2-手動デプロイ)

ボタンは、このリポジトリを自分の GitHub アカウントにコピーし、Workers Builds でビルドして R2 バケットを作成します。入力するのは 3 つのシークレットです。オーナーを一度作成したら、初期設定を閉じます。ガイドに各手順と、デプロイ後の確認項目を載せています。ボタンでデプロイできたことは、本番環境の検証が済んだことを意味しません。

## ✨ 主な機能

- パスワード、認証アプリ（TOTP）、パスキーのどれでも単独でサインインできます。少なくとも 1 つはオンのままにします。
- アップロードできるのはオーナーだけです。受け取る人は取り出しコード、または `#CODE` 付きの直接リンクで、サインインなしで受け取れます。
- テキストと大きなファイル（マルチパート）、有効期間は 1／3／7／14 日または無期限、毎時の自動クリーンアップ。
- 繁体字中国語・日本語・英語。言語ごとの静的ホームページ付き。
- Worker、Workers Static Assets、R2 だけで動きます。D1 も KV も別のウェブサービスも使いません。

## 📦 使い方

1. `/upload/` で、オンになっている方法のどれかでサインインします。
2. ファイルまたはテキストを追加し、有効期間を選んで共有を完了します。
3. 直接リンク `/retrieve/#CODE`、または取り出しページのアドレスとコードを別々にコピーします。
4. 受け取る人はアカウントなしで受け取れます。

## 🖼️ 画面キャプチャ

| | |
|:--:|:--:|
| <img src="assets/screenshots/home-ja.png" alt="ホーム" width="420"><br>ホーム | <img src="assets/screenshots/login-ja.png" alt="オーナーのサインイン" width="420"><br>オーナーのサインイン |
| <img src="assets/screenshots/upload-ja.png" alt="アップロード" width="420"><br>アップロード | <img src="assets/screenshots/share-result-ja.png" alt="共有結果" width="420"><br>共有結果 |
| <img src="assets/screenshots/retrieve-ja.png" alt="受け取り" width="420"><br>受け取り | <img src="assets/screenshots/security-settings-ja.png" alt="セキュリティ設定" width="420"><br>セキュリティ設定 |

<img src="assets/screenshots/upload-ja-mobile.png" alt="アップロード (mobile)" width="200"> <img src="assets/screenshots/retrieve-ja-mobile.png" alt="受け取り (mobile)" width="200">

`npm run screenshots` が現在のビルドから撮影したものです（[docs/SCREENSHOTS.md](docs/SCREENSHOTS.md) 参照）。表示されているコードは使い捨てのテスト用データです。

## 🛡️ セキュリティと現在の制限

- アップロードのセッションは開始から 24 時間です。それ以降の再開には対応していません。
- パスワードのハッシュ処理は CPU を多く使います。Workers の Free プランで動くとは限らないので、お使いのプランで確かめてください。
- 頼りにする前に、R2 の同時実行、Cron、レート制限、独自ドメインでのパスキー、大きなファイルを Cloudflare 上で確認する必要があります。
- CSP は Report-Only で、ダウンロードは `Range` による再開に対応していません。詳細は [docs/OPERATIONS.md](docs/OPERATIONS.md#known-limits)。

## 🛠️ 開発とテスト

```bash
npm ci
npm run setup:local        # 新しいランダムなシークレットで .dev.vars を作成
npm run preview            # ビルドして http://localhost:8787 で Worker 全体を実行
```

CI でも同じ確認を実行します。

```bash
npm run typecheck && npm run lint && npm run format:check
npm run test:unit && npm run test:worker && npm run test:contracts
npm run test:e2e           # Playwright（デスクトップと 375px）
npm run build && npx wrangler deploy --dry-run
```

[アーキテクチャ](docs/ARCHITECTURE.md) · [API](docs/API.md) · [運用](docs/OPERATIONS.md) · [オーナーの復旧](docs/RECOVERY.md) · [Cloudflare での検証](docs/REMOTE_ACCEPTANCE.md)

## 🔀 プロジェクトの由来と追加機能

[Hzao/PocketChest](https://github.com/Hzao/PocketChest) からのフォークです。このフォークでは、Worker 1 つ + R2 のみの構成、ワンクリックデプロイ、オーナー限定のアップロード、パスワード／TOTP／パスキーの独立したサインイン、セキュリティ設定、多言語 UI、共有リンクの改善、レート制限とクリーンアップの強化を加えました。独立したフォークであり、元の作者による承認を示すものではありません。

ライセンスはリポジトリの [LICENSE](LICENSE) に従います。
