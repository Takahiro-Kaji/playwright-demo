package dev.playrightdemo.cli;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Commands that do not need a shell or an application server. */
public final class Main {
    private static final Pattern PLACEHOLDER = Pattern.compile("\\$\\{([A-Z_]+)}");
    private static final Set<String> ALLOWED = Set.of("APP_IMAGE", "MOCK_IMAGE", "RDS_HOST", "APP_REGION");
    private Main() {}

    public static void main(String[] args) throws Exception {
        if (args.length > 0) {
            String[] rest = java.util.Arrays.copyOfRange(args, 1, args.length);
            switch (args[0]) {
                case "bootstrap-db" -> { BootstrapDb.main(rest); return; }
                case "configure-mocks" -> { ConfigureMocks.main(rest); return; }
                case "port-forward" -> { PortForward.main(rest); return; }
                default -> { }
            }
        }
        if (args.length != 2 || !args[0].equals("render-k8s")) {
            System.err.println("Usage: play-right-demo render-k8s <template> | bootstrap-db | configure-mocks | port-forward");
            System.exit(2);
        }
        System.out.print(render(Files.readString(Path.of(args[1])),System.getenv()));
    }
    static String render(String template, java.util.Map<String,String> environment) {
        Matcher matcher = PLACEHOLDER.matcher(template);
        StringBuffer rendered = new StringBuffer();
        while (matcher.find()) {
            String key = matcher.group(1);
            String value = environment.get(key);
            if (!ALLOWED.contains(key) || value == null || !value.matches("[a-zA-Z0-9./:_-]+")) {
                throw new IllegalArgumentException("Missing, unsupported or invalid template variable " + key);
            }
            matcher.appendReplacement(rendered, Matcher.quoteReplacement(value));
        }
        matcher.appendTail(rendered);
        if (rendered.indexOf("${") >= 0) throw new IllegalArgumentException("Unresolved template placeholder");
        return rendered.toString();
    }
}
