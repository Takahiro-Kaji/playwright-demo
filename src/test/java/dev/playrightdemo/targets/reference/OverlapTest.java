package dev.playrightdemo.targets.reference;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class OverlapTest {
    @Test void requiresTwoCompleteChangedObservationsInsideTheRequest() {
        var a = new Overlap.Observation(101, 102, 1);
        var b = new Overlap.Observation(103, 104, 2);
        assertTrue(Overlap.confirmed(100, 105, a, b));
        assertFalse(Overlap.confirmed(102, 105, a, b));
        assertFalse(Overlap.confirmed(100, 104, a, b));
        assertFalse(Overlap.confirmed(100, 105, a, new Overlap.Observation(103,104,1)));
    }
}
