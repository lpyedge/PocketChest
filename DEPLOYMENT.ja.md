# PocketChest — デプロイガイド

[English](DEPLOYMENT.md) | [繁體中文](DEPLOYMENT.zh-Hant.md) | [日本語](DEPLOYMENT.ja.md) | [PocketChest](README.ja.md)

> ファイルとテキストを共有する、自分で運用するプライベートな仕組み。Cloudflare Worker 1 つと R2 バケット 1 つだけで、データベースは不要です。

## 1. ワンクリックデプロイ（推奨）

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/lpyedge/PocketChest)

1. ボタンを押し、Cloudflare にサインインして GitHub との連携を許可します。このリポジトリが自分のアカウントにコピーされ、`wrangler.jsonc` に従って Worker、R2 バケット（`R2_STORAGE`）、レート制限のバインディング、毎時の Cron が用意されます。
2. シークレットのフォームには `JWT_SECRET`、`ADMIN_BOOTSTRAP_PASSWORD` が並び、`.dev.vars.example` のプレースホルダが入力済みになっています。**それぞれ、自分で生成したランダムな値に置き換えてください**（コマンドは[第 2 章](#2-手動デプロイ)）。プレースホルダのままのデプロイは拒否されます。API は `SERVER_MISCONFIGURED` を返し、プレースホルダのパスワードではオーナーを作成できません。
3. **Build** が `npm run build`、**Deploy** が `npx wrangler deploy` になっていることを確認して、デプロイします。
4. `https://<worker 名>.<サブドメイン>.workers.dev/upload/` を開きます。オーナーがまだ存在せず初期設定が有効な間は、初期設定用のパスワードを求められます。`ADMIN_BOOTSTRAP_PASSWORD` を入力してオーナーを作成します。変更するまで、それがオーナーのパスワードです。
5. **すぐに初期設定を閉じます。** シークレット `ADMIN_BOOTSTRAP_PASSWORD` を削除します（Worker → Settings → Variables and Secrets）。これがなければ初期設定は実行できません。続いて、ボタンが GitHub に作成したリポジトリで `wrangler.jsonc` の `BOOTSTRAP_ENABLED` を `"false"` にしてコミットし、次回以降のビルドでもオフのままにします。ダッシュボードだけで変更しても、次のビルドで上書きされます。
6. **セキュリティ設定**を開き、自分のパスワードを設定してから、認証アプリまたはパスキーを追加します。パスキーを登録する**前に**、本番のホスト名を決めて `PASSKEY_RP_ID` を設定してください（[運用](docs/OPERATIONS.md#passkey-domain)）。

**デプロイできたことは、検証が済んだことではありません。**[第 6 章](#6-インストールの確認)に従い、お使いの Cloudflare プランで R2 の同時実行、Cron、レート制限、大きなファイルを確認してください。

## 2. 手動デプロイ

**必要なもの：**Cloudflare アカウント、Node.js 22.12 以上（24 を推奨）、npm、空の R2 バケット。PocketChest は新規インストール専用で、旧バージョンのデータベースからの移行はありません。

```bash
npm ci
npx wrangler login
npx wrangler r2 bucket create pocket-chest
# 別のバケット名にする場合は、wrangler.jsonc の bucket_name も合わせて変更します。
```

**互いに異なる** 2 つの値を生成し、他人に見られない場所に保管します。

```bash
openssl rand -base64 48   # JWT_SECRET
openssl rand -base64 24   # ADMIN_BOOTSTRAP_PASSWORD：16 文字以上
# openssl がない場合：node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
```

```bash
npx wrangler secret put JWT_SECRET
npx wrangler secret put ADMIN_BOOTSTRAP_PASSWORD
```

リポジトリの `BOOTSTRAP_ENABLED` は、初回インストール用に `"true"` になっています。ビルドしてデプロイします。

```bash
npm run build
npx wrangler deploy        # または npm run deploy（先にビルドします）
```

`/upload/` を開いてオーナーを作成し、公開する前に**初期設定を閉じます**。

```bash
npx wrangler secret delete ADMIN_BOOTSTRAP_PASSWORD
# wrangler.jsonc の BOOTSTRAP_ENABLED を "false" にしてから：
npx wrangler deploy
```

初期設定を再び開くために、R2 の初期設定マーカーを削除してはいけません。初期設定が途中で止まった場合は、`node scripts/recover-bootstrap.mjs` を実行します（[オフライン復旧](docs/RECOVERY.md)参照）。

## 3. シークレットと設定

| 名前 | 種類 | 内容 |
| --- | --- | --- |
| `JWT_SECRET` | Worker シークレット | アップロードとダウンロードのトークンに署名します。24 文字以上のランダムな値で、サンプルの値は不可。 |
| `ADMIN_BOOTSTRAP_PASSWORD` | 一度だけ使う Worker シークレット | 16 文字以上。オーナーの作成に使い、**作成後は削除**します。 |
| `BOOTSTRAP_ENABLED` | `wrangler.jsonc` の変数 | 初回インストールの間だけ `"true"`。オーナー作成後は `"false"`。 |
| `PASSKEY_RP_ID` | 任意の変数 | パスキーを結び付ける唯一のホスト名。パスキーを登録する前に設定します。 |
| `R2_STORAGE` | R2 バインディング | ファイルとすべてのメタデータを、1 つのプライベートなバケットに保存します。 |
| `AUTH_LIMITER`、`RETRIEVE_LIMITER`、`UPLOAD_LIMITER`、`PART_LIMITER`、`PART_TOTAL_LIMITER`、`DOWNLOAD_LIMITER` | レート制限バインディング | サインイン、受け取り、アップロード、アップロードのパート、ダウンロードに対するクライアントごとの制限。追加のデータベースは不要です。 |

ローカル開発では `npm run setup:local` が、新しいランダムな値で `.dev.vars` を作成します。`.dev.vars` を公開しないでください。サンプルの値を実際の環境で使ってはいけません。

## 4. ビルドとデプロイの設定

GitHub からの Workers Builds では、**Build** を `npm run build`、**Deploy** を `npx wrangler deploy` にします。ここで `npm run deploy` は使わないでください。もう一度ビルドしてしまいます。`dist/` フォルダは Workers Static Assets として配信され、Worker 自体が処理するのは `/api/*` だけです。`/upload/` が白紙または 404 になる場合は、デプロイ前に `dist/` をビルドしていません。

## 5. 初期設定と日々の使い方

- 初期設定用のパスワードが、そのままオーナーのパスワードになります。**セキュリティ設定**で（16 文字以上に）変更してください。
- パスワード、認証アプリ、パスキーは、それぞれ単独でサインインできます。端末を 1 つ失っても締め出されないよう、少なくとも 2 つ設定しておきます。すべての方法を失った場合は[オフライン復旧](docs/RECOVERY.md)を参照してください。
- アップロードのセッションは開始から 24 時間で終了します。共有の有効期間は 1、3、7、14 日または無期限で、毎時のクリーンアップが期限切れを削除します。

## 6. インストールの確認

- [ ] `/`、`/ja/`、`/en/`、`/upload/`、`/retrieve/` が開く。
- [ ] オーナーは一度だけ作成され、`ADMIN_BOOTSTRAP_PASSWORD` は削除済みで、デプロイ済みの設定で `BOOTSTRAP_ENABLED` が `"false"` になっている。
- [ ] テキストと小さなファイルをアップロードでき、内容とファイル名が正しいままダウンロードできる。
- [ ] 使っているサインイン方法がすべて動き、オフにした方法ではサインインできない。
- [ ] パスワードのサインインが、お使いの Workers プランの CPU の範囲内で完了する（実測してください。[既知の制限](docs/OPERATIONS.md#known-limits)を参照）。
- [ ] 毎時の Cron がエラーなく動き、実際の Worker でレート制限が `429` を返す。
- [ ] 20 MiB を超える大きなファイルをアップロード・ダウンロードできる。
- [ ] `PASSKEY_RP_ID` を設定したうえで、本番ホスト名でパスキーが使える。

完全な一覧は [REMOTE_ACCEPTANCE.md](docs/REMOTE_ACCEPTANCE.md) にあります。ログ、クリーンアップ、保存されるキー、独自ドメイン、既知の制限は [docs/OPERATIONS.md](docs/OPERATIONS.md) を参照してください。

## 7. トラブルシューティング

| 症状 | 考えられる原因 |
| --- | --- |
| すべての `/api/*` が `SERVER_MISCONFIGURED` を返す | `JWT_SECRET` が未設定、短すぎる、またはサンプルの値のまま。 |
| 初期設定が `BOOTSTRAP_MISCONFIGURED` を返す | `ADMIN_BOOTSTRAP_PASSWORD` が 16 文字未満、またはサンプルの値のまま。 |
| 初期設定が `BOOTSTRAP_DISABLED` を返す | `BOOTSTRAP_ENABLED` が `"true"` でない、またはシークレットが未設定。 |
| 認証アプリの設定・利用で `AUTH_NOT_CONFIGURED` になる | `JWT_SECRET` が未設定・短すぎる、または認証アプリを設定したときの値と異なる。 |
| `/upload/` が白紙または 404 | デプロイ前に `dist/` をビルドしていない（第 4 章）。 |
| ストレージのエラー | R2 バケットがない、または `wrangler.jsonc` の `bucket_name` が一致していない。 |
| パスキーが `PASSKEY_DOMAIN_MISMATCH` で拒否される | `PASSKEY_RP_ID` 以外のホスト名からのリクエスト。 |

## 8. プロジェクトの由来と追加機能

[Hzao/PocketChest](https://github.com/Hzao/PocketChest) からのフォークです。このフォークでは、Worker 1 つ + R2 のみの構成、ワンクリックデプロイ、オーナー限定のアップロード、パスワード／TOTP／パスキーの独立したサインイン、セキュリティ設定、多言語 UI、共有リンクの改善、レート制限とクリーンアップの強化を加えました。独立したフォークであり、元の作者による承認を示すものではありません。
