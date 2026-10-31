package dev.playrightdemo.cli;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class RenderKubernetesTest {
    @Test void rendersAllDeploymentTemplatesAndRejectsMissingOrUnknownVariables() throws Exception {
        var values=Map.of("APP_IMAGE","example/app:1", "MOCK_IMAGE","example/mock:1", "RDS_HOST","db.example", "APP_REGION","ap-northeast-1");
        for(String name:new String[]{"demo-app","status-mock","db-tunnel"}) {
            String output=Main.render(Files.readString(Path.of("k8s",name+".yaml.tpl")),values);
            assertFalse(output.contains("${"),name);
        }
        assertThrows(IllegalArgumentException.class,()->Main.render("${APP_REGION}",Map.of()));
        assertThrows(IllegalArgumentException.class,()->Main.render("${UNSUPPORTED}",values));
    }
}
