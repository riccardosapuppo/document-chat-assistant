# Halden TP range: fault codes

Every code the TP-40 and TP-60 report on the status display, what it means, and
what to do about it. Codes beginning E are faults that stop the job; codes
beginning W are warnings that do not.

## E-4412

The head did not reach temperature within twelve seconds of the job starting.

Almost always a supply problem rather than a head problem: check that the
machine is not sharing a socket with something that draws heavily on startup.
If it happens from cold and not when warm, the thermistor is drifting and the
head needs replacing.

## E-4413

The head passed its maximum temperature and shut down.

Usually the fan intake at the rear is blocked. Do not clear it by running the
machine with the cover open: the interlock is what tells it the head is exposed,
and defeating it is how the head is destroyed.

## E-2201

The drive roller turned without the paper sensor seeing anything move.

Either the tray is empty, the gap between die-cut labels is under 2 mm, or the
sensor is dusty. In continuous mode this code cannot occur, which is a useful
thing to know: if it appears, the machine is in die-cut mode when somebody
thinks it is not.

## W-3010

The ribbon is within 20 metres of its end. The job continues.

## W-3011

The ribbon has been changed to one the machine does not recognise. The job
continues at reduced speed, because the temperature curve for an unknown ribbon
is conservative.

## E-5000

An internal fault with no more specific code. This is the only code that is
worth a call rather than a check: everything else has a cause listed above.
