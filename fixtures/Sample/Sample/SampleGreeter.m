#import "SampleGreeter.h"

@implementation SampleGreeter
- (NSString *)greet:(NSString *)name {
    return [NSString stringWithFormat:@"Hello, %@", name];
}

- (NSString *)sourceFile {
    return @__FILE__;
}
@end
