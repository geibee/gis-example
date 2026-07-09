# web UI 実装ガイドライン (共通基盤の使い方)

数百画面規模へ画面を量産するための共通 UI 基盤 (`apps/web/src/ui/`) と、新画面を追加するときの組み立て方。依存ライブラリの選定方針は [dependency-policy.md](dependency-policy.md) を参照。

## 新画面の作り方

1 画面 = **ルート + 画面コンポーネント + クエリフック + 共通 UI 部品** の組み合わせで作る。

| 置き場所 | 役割 | 見本 |
|---|---|---|
| `src/router.tsx` | ルート定義 (lazy import + staticData でタブ・タイトル・必要ロール) | `/parties` ルート |
| `src/screens/XxxScreen.tsx` | 画面状態 (検索条件・選択) と API 呼び出しの結線 | `PartiesScreen.tsx` |
| `src/queries/xxx.ts` | TanStack Query のクエリ / ミューテーション定義 (キャッシュ方針もここ) | `queries/parties.ts` |
| `src/components/XxxWorkspace.tsx` | 表示・入力の純粋なコンポーネント | `PartyWorkspace.tsx` |

手順:

1. `src/queries/` にクエリフックを追加する (キーは `queries/keys.ts` に集約)
2. `src/screens/` に画面を追加し、`src/router.tsx` にルートを足す (`staticData` でタブ強調・ページタイトル・`requiredSystemRole` が自動で効く)
3. 一覧は `ui/DataTable`、フォームは `ui/form/` + react-hook-form、通知は `notifications.ts`、削除確認は `ui/ConfirmDialog` を使う
4. テストは `testing/renderWithProviders` + MSW (`testing/handlers.ts`) で書く。見本: `screens/PartiesScreen.test.tsx`

## 一覧テーブル: `ui/DataTable`

型付きの列定義を渡す薄い共通テーブル。行クリック選択・選択行ハイライト・件数表示・クライアントページング (`pageSize`) を備える。

```tsx
const columns: Array<DataTableColumn<Party>> = [
  { key: "id", header: "ID", render: (party) => party.id },
  { key: "name", header: "名称", render: (party) => party.name }
];

<DataTable columns={columns} rows={items} rowKey={(p) => p.id}
  onRowClick={(p) => onSelect(p.id)} selectedRowKey={selectedId}
  emptyMessage="関係者はありません" pageSize={50} />
```

ソートやサーバサイドページングが必要になった時点で TanStack Table への置き換えを検討する (列定義ベースの props はその移行を想定した形)。

## フォーム: react-hook-form + zod

- **典型フォーム (CRUD・設定・検索) は React Hook Form** を使う。スキーマは zod で書き、`zodResolver` で接続する。**エラーメッセージは日本語でスキーマ側に持つ**。
- **動的ネスト配列が中核の複雑編集フォーム**を作る画面だけは TanStack Form の併用可 (dependency-policy.md 参照)。現状該当画面はない。
- フィールドは `ui/form/fields.tsx` の共通部品 (`TextField` / `NumberField` / `SelectField` / `TextAreaField`) を使う。ラベル・必須マーク・エラー表示・aria 属性 (`aria-invalid` / `aria-describedby` / `role=alert`) が統一される。

```tsx
const schema = z.object({
  name: z.string().trim().min(1, "名称を入力してください")
});

const { register, handleSubmit, formState: { errors } } = useForm({
  resolver: zodResolver(schema), defaultValues
});

<form onSubmit={handleSubmit(onSubmit)} noValidate>
  <TextField label="名称" required error={errors.name?.message} {...register("name")} />
</form>
```

見本実装: `components/PartyForm.tsx` (作成/編集のスキーマ切り替え、`form=` 属性でフォーム外の保存ボタンと関連付け、編集対象の切り替えは `key` でフォームをリセット)。

### useWatch の注意 (RHF のレンダリング特性)

`watch()` / 引数なし `useWatch()` はフォーム全体を購読し、キー入力のたびに購読コンポーネントが再レンダリングされる。以下を徹底する (dependency-policy.md の対策レベル 1〜4):

1. 入力は `register` を優先し、値の購読自体を避ける
2. 購読が必要なら `useWatch({ name: "field" })` で**フィールド名を限定**する
3. 購読して計算・表示する部分は**子コンポーネントに隔離**し、再レンダリングをそこで止める (見本: `PartyForm.tsx` の `PartyFormHeader`)
4. 送信時にしか使わない値は `getValues()` で読む (購読しない)

## 通知トースト: `notifications.ts` + `ui/Toaster`

種別付きの通知はどこからでも (React ツリー外含め) 発火できる。表示ホスト (`<Toaster />`) は App に配置済み。

```ts
notifySuccess("保存しました");     // 緑・4 秒
notifyError("保存に失敗しました");  // 赤・8 秒・role=alert (スクリーンリーダーに即時通知)
notifyInfo("検索結果はありません"); // 琥珀・6 秒
```

複数同時表示 (上限 5)・自動消滅・手動クローズ対応。単一 `notice` state は廃止した。

## 削除などの確認: `ui/ConfirmDialog`

`window.confirm` は使わない。Promise ベースでフォーカストラップ・Esc・`role=alertdialog` に対応する。

```ts
const confirmed = await confirmDialog({
  title: "土地の削除", message: `${id} を削除しますか`,
  confirmLabel: "削除", danger: true
});
if (!confirmed) return;
```

## テスト

- 共通部品の単体テスト: `ui/*.test.tsx` を参照
- 画面テスト: `renderWithProviders({ path: "/xxx" })` + MSW。フォームは「必須エラーの表示 → 入力 → 送信ペイロード検証」の形にする (`screens/PartiesScreen.test.tsx`)
