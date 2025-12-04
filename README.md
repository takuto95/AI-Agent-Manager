# BMAD開発用メモ

## BMADとは
BMADはコーネル大学CLASSEが開発しているビームダイナミクス用のFortran/C++ライブラリ群で、粒子加速器のシミュレーションや軌道設計を行うためのツールセットです。ソースコードはGPLv3で公開されており、ライブラリ本体に加えて`tao`や`bmad-lattice`などの関連ユーティリティが含まれます。

## 必要環境
- LinuxまたはmacOS (WSL2可)
- gfortran 9以降、または同等のFortranコンパイラ
- GCC/Clang (BMADにはC/C++コードも含まれるため)
- Python 3.8+ と `pip`
- SCons 4.x (BMADはSConsビルドシステムを採用)
- CMake (一部ツールで利用)
- git、make、cmake、pkg-config 等のビルド補助ツール

### 推奨ライブラリ
- `readline`, `ncurses`
- `fftw3`, `lapack`, `blas`
- `xraylib` (X線関連計算を行う場合)
- `Qt`/`X11` (可視化ツール用)

## セットアップ手順
1. **依存関係の導入** (例: Ubuntu)
   ```bash
   sudo apt update
   sudo apt install gfortran g++ make cmake python3 python3-pip scons \
       libreadline-dev libncurses-dev libfftw3-dev liblapack-dev libblas-dev \
       pkg-config git
   ```
2. **BMAD本体の取得**
   ```bash
   git clone https://github.com/bmad-sim/bmad.git
   cd bmad
   ```
3. **環境変数の設定**
   ```bash
   export ACC_ROOT_DIR=$HOME/acc
   export PATH=$ACC_ROOT_DIR/bin:$PATH
   export LD_LIBRARY_PATH=$ACC_ROOT_DIR/lib:$LD_LIBRARY_PATH
   ```
   `ACC_ROOT_DIR`はBMADと関連ツールをインストールするルートディレクトリを示します。必要なら`~/.bashrc`に追記してください。
4. **サブモジュールと依存ライブラリの取得**
   ```bash
   git submodule update --init --recursive
   ```
5. **ビルドとインストール**
   ```bash
   scons install
   ```
   成功すると`$ACC_ROOT_DIR/bin`以下に`tao`などの実行ファイルが生成されます。

## よく使うターゲット
- `scons -j$(nproc) install` : 並列ビルド
- `scons clean` : 生成物の削除
- `scons tao` : `tao`のみビルド
- `scons tests` : 単体テスト

## 開発フロー
1. `main`からトピックブランチを作成
2. 変更箇所に対応するテストや入力ファイル(`.bmad`)を追加
3. `scons tests`でリグレッションを確認
4. `clang-format`/`fprettify`等でコード整形
5. PRには、再現条件と期待挙動をREADMEか`docs/`に追記

## 参考ドキュメント
- 公式ドキュメント: https://www.classe.cornell.edu/~bmad/
- Taoマニュアル: https://www.classe.cornell.edu/~dcs/bmad/tao_manual.pdf
- BMADチュートリアル: https://www.classe.cornell.edu/~dcs/bmad/bmad_tutorial.pdf

## トラブルシューティング
- **SConsがコンパイラを見つけられない**: `which gfortran`の結果を確認し、`PATH`を再設定。
- **`ld: cannot find -lreadline`**: 開発ヘッダ`libreadline-dev`が未インストール。
- **OpenMP関連エラー**: `gfortran`に`-fopenmp`が渡っているか`scons_arguments`を確認。
- **macOSで`install_name`警告**: `install_name_tool`で`@rpath`を補正、または`DYLD_LIBRARY_PATH`に`$ACC_ROOT_DIR/lib`を追加。