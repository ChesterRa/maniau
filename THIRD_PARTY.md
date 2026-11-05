# 第三者の物

このリポジトリが使う、第三者のデータ・素材の出典と利用条件。依存のライブラリは `pnpm-lock.yaml` で固定し、それぞれの利用条件に従う。

## 日本の国民の祝日（`packages/core/src/time/holidays-jp.ts`）

- 出典：内閣府「国民の祝日について」の CSV（https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv）。2026-11-02 に取得し、2026〜2027年の分を変換した。
- 利用条件：内閣府ホームページ利用規約（令和7年3月25日現在）により、公共データ利用規約（第1.0版）（デジタル庁）に従う。出典：内閣府ホームページ（https://www8.cao.go.jp/chosei/shukujitsu/gaiyou.html）。

## 周りの調べの記録（`data/demo/recorded/survey.json`）

- 中身：2026-11-05 に、デモの家の地域（東京都江東区・豊洲）の周りを、Claude（ウェブ検索と頁の読み取り）で一度だけ調べた結果。候補ごとに、Claude が書いたまとめ・地域・事前の登録の読みと、出典の頁の URL・題・読んだ時刻、Claude が根拠に挙げた文が頁の本文にあったかをコードが照らした結果を持つ。
- 持たない物：頁の本文と、引用として抜き出した頁の文。引用は、照らす時にだけ使い、画面にも出さない（まとめは Claude が書いた一文で、頁の言葉や文を含むことがある）（2026-11-05 に、出していた引用を外した。前の記録は公開の履歴に残る）。
- 出典の頁（題は読んだ時の物）：
  - 江東区「病児・病後児保育」 https://www.city.koto.lg.jp/280307/kodomo/kosodate/service/20788.html
  - 江東区「非定型一時保育（子育てサポート一時保育）」 https://www.city.koto.lg.jp/280307/kodomo/kosodate/service/ichijihoiku/5924.html
  - 江東区「リフレッシュひととき保育」 https://www.city.koto.lg.jp/282011/kodomo/kosodate/service/ichijihoiku/25665.html
  - 豊洲めぐみこども園「一時保育」 https://www.megumi.ed.jp/toyosu/rearing/temporary/
  - 江東区社会福祉協議会「ファミリー・サポート・センター」 https://koto-shakyo.or.jp/familyc/
- 江東区の頁の利用条件は、区の「著作権・リンクについて」（https://www.city.koto.lg.jp/011501/8787.html）を参照。画面は、頁の題と、頁を開くリンクを出す。施設の名前・中身・事前の登録が今も正しいかは確かめていない（画面でも、頁を開いて確かめてもらう）。
