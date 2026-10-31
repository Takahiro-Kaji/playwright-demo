package dev.playrightdemo.scenarios.ui;

import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

/** The nine route/scenario selections use the shared UI orchestration. */
@Tag("local-ui")
class LocalUiTest extends UiCaseRunner {
    @Test void fixedA_success() throws Exception { execute(200,"a",false); }
    @Test void fixedA_externalError() throws Exception { execute(503,"a",false); }
    @Test void fixedA_noSwitch() throws Exception { execute(200,"a",true); }
    @Test void fixedB_success() throws Exception { execute(200,"b",false); }
    @Test void fixedB_externalError() throws Exception { execute(503,"b",false); }
    @Test void fixedB_noSwitch() throws Exception { execute(200,"b",true); }
    @Test void random_success() throws Exception { execute(200,"random",false); }
    @Test void random_externalError() throws Exception { execute(503,"random",false); }
    @Test void random_noSwitch() throws Exception { execute(200,"random",true); }

}
