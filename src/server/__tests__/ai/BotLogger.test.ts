import {
  BotLogger,
  BotLogLevel,
  setGlobalBotLogLevel,
  getGlobalBotLogLevel,
} from '../../ai/BotLogger';

describe('BotLogger', () => {
  let originalLogLevel: BotLogLevel;

  beforeEach(() => {
    originalLogLevel = getGlobalBotLogLevel();
    setGlobalBotLogLevel(BotLogLevel.TRACE);
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();
  });

  afterEach(() => {
    setGlobalBotLogLevel(originalLogLevel);
    jest.restoreAllMocks();
  });

  describe('message formatting', () => {
    it('should format messages with context prefix', () => {
      const logger = new BotLogger('TestModule');
      logger.info('hello world');

      expect(console.log).toHaveBeenCalledWith(
        '[BOT:INFO] [TestModule] hello world'
      );
    });

    it('should include game and bot IDs when provided', () => {
      const logger = new BotLogger(
        'TestModule',
        'abcd1234-5678-9abc-def0-123456789abc',
        'bot01234-5678-9abc-def0-123456789abc'
      );
      logger.info('test message');

      expect(console.log).toHaveBeenCalledWith(
        '[BOT:INFO] [TestModule] [game:abcd1234] [bot:bot01234] test message'
      );
    });

    it('should append JSON data when provided', () => {
      const logger = new BotLogger('TestModule');
      logger.info('action taken', { action: 'BuildTrack', cost: 15 });

      expect(console.log).toHaveBeenCalledWith(
        '[BOT:INFO] [TestModule] action taken {"action":"BuildTrack","cost":15}'
      );
    });

    it('should not append data when not provided', () => {
      const logger = new BotLogger('TestModule');
      logger.info('simple message');

      expect(console.log).toHaveBeenCalledWith(
        '[BOT:INFO] [TestModule] simple message'
      );
    });
  });

  describe('log levels', () => {
    it('should use correct level labels', () => {
      const logger = new BotLogger('Test');

      logger.trace('t');
      logger.debug('d');
      logger.info('i');
      logger.warn('w');
      logger.error('e');

      expect(console.log).toHaveBeenCalledWith('[BOT:TRACE] [Test] t');
      expect(console.log).toHaveBeenCalledWith('[BOT:DEBUG] [Test] d');
      expect(console.log).toHaveBeenCalledWith('[BOT:INFO] [Test] i');
      expect(console.warn).toHaveBeenCalledWith('[BOT:WARN] [Test] w');
      expect(console.error).toHaveBeenCalledWith('[BOT:ERROR] [Test] e');
    });

    it('should route warn to console.warn', () => {
      const logger = new BotLogger('Test');
      logger.warn('warning');

      expect(console.warn).toHaveBeenCalledTimes(1);
      expect(console.log).not.toHaveBeenCalled();
      expect(console.error).not.toHaveBeenCalled();
    });

    it('should route error to console.error', () => {
      const logger = new BotLogger('Test');
      logger.error('failure');

      expect(console.error).toHaveBeenCalledTimes(1);
      expect(console.log).not.toHaveBeenCalled();
      expect(console.warn).not.toHaveBeenCalled();
    });
  });

  describe('log level filtering', () => {
    it('should suppress messages below the global log level', () => {
      setGlobalBotLogLevel(BotLogLevel.WARN);
      const logger = new BotLogger('Test');

      logger.trace('trace');
      logger.debug('debug');
      logger.info('info');
      logger.warn('warn');
      logger.error('error');

      expect(console.log).not.toHaveBeenCalled();
      expect(console.warn).toHaveBeenCalledTimes(1);
      expect(console.error).toHaveBeenCalledTimes(1);
    });

    it('should allow all messages when set to TRACE', () => {
      setGlobalBotLogLevel(BotLogLevel.TRACE);
      const logger = new BotLogger('Test');

      logger.trace('t');
      logger.debug('d');
      logger.info('i');
      logger.warn('w');
      logger.error('e');

      expect(console.log).toHaveBeenCalledTimes(3); // trace, debug, info
      expect(console.warn).toHaveBeenCalledTimes(1);
      expect(console.error).toHaveBeenCalledTimes(1);
    });

    it('should suppress all except error when set to ERROR', () => {
      setGlobalBotLogLevel(BotLogLevel.ERROR);
      const logger = new BotLogger('Test');

      logger.trace('t');
      logger.debug('d');
      logger.info('i');
      logger.warn('w');
      logger.error('e');

      expect(console.log).not.toHaveBeenCalled();
      expect(console.warn).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledTimes(1);
    });
  });

  describe('withContext', () => {
    it('should create a new logger with game and bot context', () => {
      const baseLogger = new BotLogger('Engine');
      const contextLogger = baseLogger.withContext(
        'game1234-5678-9abc-def0-123456789abc',
        'bot0abcd-5678-9abc-def0-123456789abc'
      );

      contextLogger.info('turn started');

      expect(console.log).toHaveBeenCalledWith(
        '[BOT:INFO] [Engine] [game:game1234] [bot:bot0abcd] turn started'
      );
    });

    it('should not modify the original logger', () => {
      const baseLogger = new BotLogger('Engine');
      baseLogger.withContext('game-id', 'bot-id');

      baseLogger.info('no context');

      expect(console.log).toHaveBeenCalledWith(
        '[BOT:INFO] [Engine] no context'
      );
    });
  });

  describe('global log level', () => {
    it('should get and set the global level', () => {
      setGlobalBotLogLevel(BotLogLevel.DEBUG);
      expect(getGlobalBotLogLevel()).toBe(BotLogLevel.DEBUG);

      setGlobalBotLogLevel(BotLogLevel.ERROR);
      expect(getGlobalBotLogLevel()).toBe(BotLogLevel.ERROR);
    });
  });
});
