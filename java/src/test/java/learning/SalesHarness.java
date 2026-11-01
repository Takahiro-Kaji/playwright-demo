package learning;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.net.ServerSocket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.*;
import java.sql.*;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.TimeUnit;

/** 専用 DB と子プロセスを所有する。失敗時も停止確認できなければ DB を残す。 */
final class SalesHarness implements AutoCloseable {
  static final ObjectMapper JSON = new ObjectMapper();
  static final Path ROOT = Path.of("..").toAbsolutePath().normalize();
  final Path dir = ROOT.resolve(".local/sales-learning/java-" + UUID.randomUUID());
  final Path db = dir.resolve("sales.sqlite");
  final Path catalog = dir.resolve("catalog.json");
  final String token = UUID.randomUUID().toString() + UUID.randomUUID();
  final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2)).build();
  final List<Process> processes = new ArrayList<>();
  final List<Throwable> afterErrors = new ArrayList<>();
  String upstream, app;
  boolean preserve;

  // 空きポートを一時的に確保して番号を選ぶ。後続の起動失敗も回収対象にする。
  static int port() throws IOException {
    try (ServerSocket socket = new ServerSocket(0)) {
      return socket.getLocalPort();
    }
  }

  /** 商品コード・名称・価格・在庫数から、上流 fixture の1商品を返す。 */
  static Map<String, Object> product(String code, String name, int price, int quantity) {
    return Map.of(
        "productCode", code, "name", name, "price", price, "quantity", quantity, "active", true);
  }

  // デモの期待値は実際の DB や API 応答から生成せず、事前に固定する。
  /** version が1なら F1、2なら F2 を表す固定データを返す。 */
  static Map<String, Object> fixture(int version) {
    return Map.of(
        "catalogVersion",
        version,
        "products",
        List.of(product("P001", "ペン", 120, version == 1 ? 5 : 3), product("P002", "ノート", 300, 2)));
  }

  /** 上流が読む fixture ファイルへ data を書く。戻り値はない。 */
  void catalog(Object data) throws IOException {
    JSON.writeValue(catalog.toFile(), data);
  }

  /** Node の引数配列と環境変数を受け取り、回収対象に登録したプロセスを返す。 */
  Process start(List<String> arguments, Map<String, String> env) throws IOException {
    var cmd = new ArrayList<String>();
    cmd.add("node");
    cmd.addAll(arguments);
    var builder =
        new ProcessBuilder(cmd)
            .directory(ROOT.toFile())
            .redirectOutput(ProcessBuilder.Redirect.DISCARD)
            .redirectError(ProcessBuilder.Redirect.DISCARD);
    builder.environment().putAll(env);
    Process p = builder.start();
    processes.add(p);
    return p;
  }

  void waitReady(String url, Process p) throws Exception {
    for (int i = 0; i < 100; i++) {
      if (!p.isAlive()) throw new IOException("process exited while starting");
      try {
        get(url);
        return;
      } catch (IOException e) {
        Thread.sleep(50);
      }
    }
    throw new IOException("process start timeout");
  }

  static final class StartCleanupFailure extends Exception {
    StartCleanupFailure(Throwable start, Throwable cleanup) {
      super("start failed and cleanup was not confirmed", start);
      addSuppressed(cleanup);
    }
  }

  // 起動途中で失敗しても、それまでに起動した子プロセスを必ず回収する。
  static SalesHarness open(boolean mock) throws Exception {
    SalesHarness h = new SalesHarness();
    try {
      Files.createDirectories(h.dir);
      h.catalog(fixture(1));
      int upPort = port(), appPort = port();
      h.upstream = "http://127.0.0.1:" + upPort;
      h.app = "http://127.0.0.1:" + appPort;
      Process up =
          h.start(
              List.of("demo/sales/server.ts", mock ? "mock" : "upstream"),
              Map.of(
                  "PORT",
                  "" + upPort,
                  "MOCK_TOKEN",
                  h.token,
                  "SALES_CATALOG_FILE",
                  h.catalog.toString()));
      h.waitReady(h.upstream + "/catalog", up);
      Process app =
          h.start(
              List.of("demo/sales/server.ts", "app"),
              Map.of(
                  "PORT", "" + appPort, "SALES_DB", h.db.toString(), "UPSTREAM_URL", h.upstream));
      h.waitReady(h.app + "/", app);
      return h;
    } catch (Exception e) {
      try {
        h.close();
      } catch (Exception cleanup) {
        throw new StartCleanupFailure(e, cleanup);
      }
      throw e;
    }
  }

  HttpResponse<String> get(String url) throws Exception {
    return http.send(
        HttpRequest.newBuilder(URI.create(url)).timeout(Duration.ofSeconds(4)).GET().build(),
        HttpResponse.BodyHandlers.ofString());
  }

  // 現在のモック状態を取得する。復元先は試験ごとにこの戻り値で決める。
  int status() throws Exception {
    var req =
        HttpRequest.newBuilder(URI.create(upstream + "/admin/status"))
            .timeout(Duration.ofSeconds(4))
            .header("Authorization", "Bearer " + token)
            .GET()
            .build();
    var response = http.send(req, HttpResponse.BodyHandlers.ofString());
    if (response.statusCode() != 200) throw new IOException("mock control failed");
    return JSON.readTree(response.body()).get("status").asInt();
  }

  /** モックの HTTP ステータスを value に変更し、管理 API の応答値を返す。 */
  int status(int value) throws Exception {
    var req =
        HttpRequest.newBuilder(URI.create(upstream + "/admin/status"))
            .timeout(Duration.ofSeconds(4))
            .header("Authorization", "Bearer " + token)
            .header("Content-Type", "application/json")
            .PUT(HttpRequest.BodyPublishers.ofString("{\"status\":" + value + "}"))
            .build();
    var response = http.send(req, HttpResponse.BodyHandlers.ofString());
    if (response.statusCode() != 200) throw new IOException("mock control failed");
    return JSON.readTree(response.body()).get("status").asInt();
  }

  Process batchStart() throws IOException {
    return start(
        List.of("demo/sales/batch.ts"),
        Map.of("SALES_DB", db.toString(), "UPSTREAM_URL", upstream));
  }

  // 同期バッチの終了だけでは成功とせず、呼び出し元で DB 全体も照合する。
  int batch() throws Exception {
    Process p = batchStart();
    if (!p.waitFor(20, TimeUnit.SECONDS)) throw new IOException("batch timeout");
    return p.exitValue();
  }

  Connection connection() throws SQLException {
    return DriverManager.getConnection("jdbc:sqlite:" + db);
  }

  /** SQL の全行を列順のリストとして返す。呼び出し側で固定期待値と比較する。 */
  List<List<Object>> query(String sql) throws SQLException {
    try (Connection c = connection();
        Statement s = c.createStatement();
        ResultSet rs = s.executeQuery(sql)) {
      List<List<Object>> result = new ArrayList<>();
      int columns = rs.getMetaData().getColumnCount();
      while (rs.next()) {
        List<Object> row = new ArrayList<>();
        for (int i = 1; i <= columns; i++) row.add(rs.getObject(i));
        result.add(row);
      }
      return result;
    }
  }

  void execute(String sql) throws SQLException {
    try (Connection c = connection();
        Statement s = c.createStatement()) {
      s.executeUpdate(sql);
    }
  }

  // 4表を同じ読み取りトランザクションで取得し、操作前後を比較できるようにする。
  Map<String, List<List<Object>>> snapshot() throws SQLException {
    try (Connection c = connection();
        Statement s = c.createStatement()) {
      c.setAutoCommit(false);
      Map<String, List<List<Object>>> result = new LinkedHashMap<>();
      for (String table : List.of("products", "inventory", "orders", "sync_state")) {
        List<List<Object>> rows = new ArrayList<>();
        try (ResultSet rs = s.executeQuery("SELECT * FROM " + table + " ORDER BY 1")) {
          int n = rs.getMetaData().getColumnCount();
          while (rs.next()) {
            List<Object> row = new ArrayList<>();
            for (int i = 1; i <= n; i++) row.add(rs.getObject(i));
            rows.add(row);
          }
        }
        result.put(table, rows);
      }
      c.commit();
      return result;
    }
  }

  // 全プロセスの終了を確認し、確認できない場合は復旧用の DB を残す。
  @Override
  public void close() throws Exception {
    List<Long> alive = new ArrayList<>();
    for (Process p : processes) if (p.isAlive()) p.destroy();
    for (Process p : processes) {
      if (!p.waitFor(2, TimeUnit.SECONDS)) {
        p.destroyForcibly();
        if (!p.waitFor(2, TimeUnit.SECONDS)) alive.add(p.pid());
      }
    }
    if (!alive.isEmpty()) {
      preserve = true;
      throw new IOException("PROCESS_STOP_UNCONFIRMED directory=" + dir + " pids=" + alive);
    }
    if (!preserve && Files.exists(dir))
      try (var paths = Files.walk(dir)) {
        for (Path p : paths.sorted(Comparator.reverseOrder()).toList()) Files.delete(p);
      }
  }
}
