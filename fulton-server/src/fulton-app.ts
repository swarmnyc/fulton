import { EventEmitter } from 'events';
import * as express from 'express';
import { Express } from 'express';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as lodash from 'lodash';
import * as path from 'path';
import { Connection, Repository } from 'typeorm';
import { EntityMetadata } from 'typeorm/metadata/EntityMetadata';
import * as winston from 'winston';
import { FultonLog } from './fulton-log';
import { fultonDebug, fultonDebugMaster } from './helpers/debug';
import { Env } from './helpers/env';
import { Helper } from './helpers/helper';
import { ClassProvider, FactoryProvider, FunctionProvider, Provider, TypeProvider, ValueProvider } from './helpers/type-helpers';
import { IUser, IUserService } from './identity/interfaces';
import { AppMode, DiContainer, EntityServiceFactory, ICacheProvideService, ICacheService, IEntityService, INotificationService, NotificationMessage, Response, Type, TypeIdentifier } from './interfaces';
import { DiKeys, EventKeys } from './keys';
import { defaultHttpLoggerHandler } from './middlewares/http-logger';
import { FultonAppOptions } from './options/fulton-app-options';
import { BaseOptions } from './options/options';
import { Router } from './routers/router';



// don't load too modules classes here, it will cause cyclical dependencies and cause very hard to debug and wired Error.

export interface IFultonApp {
    readonly isInitialized: boolean;

    /**
     * app name, use in output, parser. default is class name.
     */
    readonly appName: string;

    /**
     * app mode.
     */
    readonly mode: AppMode;

    /**
     * the instance of Express, created during init().
     */
    express: Express;

    /**
     * Dependency Injection container, created during init()
     */
    container: DiContainer;

    /**
     * options for Fulton
     */
    options: FultonAppOptions;


    /**
     * the EventEmitter, see EventKeys for all the events
     * 
     * ## example
     * ```
     * app.events.on(EventKeys.AppDidInit, (app:FultonApp)=>{});
     * ```
     */
    events: EventEmitter;

    /**
     * user service, created during init() if options.identity.enabled = true.
     */
    userService: IUserService<IUser>;

    /**
     * the instance of http server of nodejs, created during start()
     */
    httpServer: http.Server;

    /**
     * the instance of https server of nodejs, created during start()
     */
    httpsServer: https.Server;

    /**
     * database connections, created during init();
     */
    dbConnections: Connection[];

    /**
     * the metadatas of the entities, which added after initDatabases
     */
    entityMetadatas: Map<Type, EntityMetadata>;

    /**
     * routers, created during initRouters();
     */
    routers: Router[];

    /**
     * the base url, it is generated by every request, it will be like https://domain.com/
     */
    baseUrl: string;

    /**
     * initialize FultonApp. It will be called on start(), if the app isn't initialized;
     * it can be run many times, every times call this will reset all the related objects
     */
    init(): Promise<void>;

    /**
     * start http server or https server. if it isn't initialized, it will call init(), too.
     */
    start(): Promise<any>;

    /**
     * stop http server or https server and dbConnections
     */
    stop(): Promise<any>;

    /**
     * get data from res.locals[key], and use Zone to manage context
     */
    getLocalData(key: string): any;

    /**
     * set data from res.locals[key], and use Zone to manage context
     */
    setLocalData(key: string, value: any): void;

    /**
     * use type or key to get instance from DI container
     */
    getInstance<T>(type: Type<T>): T
    getInstance<T>(key: string): T

    /**
     * A shortcut to get typeorm repository
     */
    getRepository<T>(entity: Type, connectionName?: string): Repository<T>

    /**
     * A shortcut to get typeorm repository
     */
    getEntityService<T>(entity: Type, connectionName?: string): IEntityService<T>

    /**
     * A shortcut to get typeorm repository
     */
    getCacheService(category: string): ICacheService

    /**
     * call NotificationService to send messages, message can be email, sms or push-notification
     * @param messages 
     */
    sendNotifications(...messages: NotificationMessage[]): Promise<void>;
}

/**
 * The app of Fulton Server, it is the main class of Fulton Server
 * 
 * `onInit` is the required function when extends from FultonApp
 */
export abstract class FultonApp implements IFultonApp {
    private assetFolder = "./assets"

    appName: string;

    express: Express;

    container: DiContainer;

    options: FultonAppOptions;

    events: EventEmitter;

    userService: IUserService<IUser>;

    httpServer: http.Server;

    httpsServer: https.Server;

    dbConnections: Connection[];

    entityMetadatas: Map<Type, EntityMetadata>;

    routers: Router[];

    baseUrl: string;

    isInitialized: boolean = false;

    notificationService: INotificationService;

    /**
     * @param mode There are some different default values for api and web-view. 
     */
    constructor(appName?: string, public mode: AppMode = "api") {
        this.appName = appName || this.constructor.name;
        this.options = new FultonAppOptions(this.appName, mode);
        this.events = new EventEmitter();
        this.entityMetadatas = new Map();
        this.dbConnections = [];
        this.routers = [];
    }

    async init(): Promise<void> {
        try {
            await this.initServer();

            await this.initDiContainer();

            await this.onInit(this.options);
            this.options.init();

            await this.initPreIdentity();

            await this.initLogging();

            await this.initProviders();

            await this.initDatabases();

            await this.initServices();

            /* start express middlewares */
            await this.initHttpLogging();

            await this.initCors();

            await this.initSecurity();

            await this.initCompression();

            await this.initFormatter();

            await this.initIdentity();

            await this.initIndex();

            await this.initStaticFile();

            await this.initMiddlewares();

            await this.initRouters();

            await this.initDocs();

            await this.initErrorHandler();
            /* end express middlewares */

            this.isInitialized = true;
            this.events.emit(EventKeys.AppDidInit, this);

            fultonDebugMaster("app", this.outputOptions("Initializing with options:\t%O\t"))
        } catch (error) {
            fultonDebug("app", this.outputOptions("App Init failed with:\t%O\t"))
            //FultonLog.error("App Init failed by", error)
            throw error;
        }
    }

    start(): Promise<any> {
        if (this.httpServer || this.httpsServer) {
            return Promise.reject(new Error(`${this.appName} is still running`));
        }

        if (this.options.miscellaneous.zoneEnabled) {
            require("zone.js");
        }

        let initTask: Promise<any>
        if (this.isInitialized) {
            initTask = Promise.resolve();
        } else {
            initTask = this.init().catch((err) => {
                FultonLog.error(`${this.appName} failed to initialization`, err);
                return Promise.reject(err);
            });
        }

        return initTask.then(() => {
            var tasks = [];

            if (this.options.server.httpEnabled) {
                tasks.push(new Promise((resolve, reject) => {
                    this.httpServer = http
                        .createServer(this.serve)
                        .on("error", (error) => {
                            FultonLog.error(`${this.appName} failed to start http server on port ${this.options.server.httpPort}`);
                            this.httpServer = null;
                            reject(error);
                        })
                        .listen(this.options.server.httpPort, () => {
                            FultonLog.info(`${this.appName} is running http server on port ${this.options.server.httpPort}`)
                            resolve()
                        });
                }));
            }

            if (this.options.server.httpsEnabled) {
                tasks.push(new Promise((resolve, reject) => {
                    if (!this.options.server.sslOptions) {
                        if (Env.isProduction) {
                            let error = `${this.appName} failed to start because https is enabled but sslOption wasn't given`;
                            FultonLog.error(error);
                            reject(error);
                            return;
                        } else {
                            // if ssl options is empty,  use default ssl options
                            this.options.server.sslOptions = {
                                cert: fs.readFileSync(path.join(__dirname, this.assetFolder, "ssl/localhost.crt")),
                                key: fs.readFileSync(path.join(__dirname, this.assetFolder, "ssl/localhost.key"))
                            }

                            FultonLog.warn(`${this.appName} is using dev ssl certification which is for development only, you should change sslOption for production`);
                        }
                    }

                    this.httpsServer = https
                        .createServer(this.options.server.sslOptions, this.serve)
                        .on("error", (error) => {
                            FultonLog.error(`${this.appName} failed to start https server on port ${this.options.server.httpsPort}`);
                            this.httpsServer = null;
                            reject(error);
                        })
                        .listen(this.options.server.httpsPort, () => {
                            FultonLog.info(`${this.appName} is running https server on port ${this.options.server.httpsPort}`);
                            resolve()
                        });
                }));
            }

            return Promise.all(tasks);
        });
    }

    stop(): Promise<any> {
        var tasks: Promise<any>[] = [];

        if (this.dbConnections) {
            tasks.push(...this.dbConnections.map((conn) => conn.close()));
        }

        if (this.httpServer) {
            tasks.push(new Promise((resolve, reject) => {
                this.httpServer.close(() => {
                    FultonLog.info(`${this.appName} stopped http server`);
                    resolve();
                })
            }));
        }

        if (this.httpsServer) {
            tasks.push(new Promise((resolve, reject) => {
                this.httpsServer.close(() => {
                    FultonLog.info(`${this.appName} stopped https server`);
                    resolve();
                })
            }));
        }

        return Promise.all(tasks);
    }

    getLocalData(key: string): any {
        if (this.options.miscellaneous.zoneEnabled) {
            let res: Response = Zone.current.get("res");
            if (res) {
                return res.locals[key];
            }
        }
    }

    setLocalData(key: string, value: any) {
        if (this.options.miscellaneous.zoneEnabled) {
            let res: Response = Zone.current.get("res");
            if (res) {
                res.locals[key] = value;
            }
        }
    }

    getInstance<T>(key: Type | string): T {
        return this.container.get<T>(key);
    }

    getRepository<T>(entity: Type, connectionName?: string): Repository<T> {
        return require("typeorm").getRepository(entity, connectionName);
    }

    getEntityService<T>(entity: Type, connectionName?: string): IEntityService<T> {
        let factory = this.container.get<EntityServiceFactory>(DiKeys.EntityServiceFactory);
        if (factory instanceof Function) {
            // factory
            return factory(entity, connectionName);
        } else {
            // instance
            return factory;
        }
    }

    getCacheService(category?: string): ICacheService {
        let provider = this.container.get<ICacheProvideService>(DiKeys.CacheProviderService)

        return provider.getCacheService(category)
    }

    sendNotifications(...messages: NotificationMessage[]): Promise<void> {
        if (!this.options.notification.enabled) return

        if (this.notificationService == null) {
            this.notificationService = this.getInstance(DiKeys.NotificationService)
        }

        return this.notificationService.send(...messages);
    }

    // initialization functions
    protected initCache(): void | Promise<void> {
        if (this.options.cache.enabled) {
            return require('./initializers/cache-initializer')(this)
        } 
    }

    protected initCors(): void | Promise<void> {
        if (this.options.cors.enabled) {
            // won't load cors module if it is not enabled;
            return require('./initializers/cors-initializer')(this)
        }
    }

    protected initCompression(): void | Promise<void> {
        if (this.options.compression.enabled) {
            // won't load compression module if it is not enabled;
            return require('./initializers/compression-initializer')(this)
        }
    }

    /**
     * init databases, it will be ignored if repository is empty.
     */
    protected initDatabases(): Promise<void> {
        return require('./initializers/database-initializer')(this);
    }

    protected initDiContainer(): void | Promise<void> {
        return require('./initializers/di-initializer')(this);
    }

    protected initDocs(): void | Promise<void> {
        if (this.options.docs.enabled) {
            require("./initializers/docs-initializer")(this);
        }
    }

    protected initErrorHandler(): void | Promise<void> {
        if (this.options.errorHandler) {
            if (lodash.some(this.options.errorHandler.error404Middlewares)) {
                this.express.use(...this.options.errorHandler.error404Middlewares);
            }

            if (lodash.some(this.options.errorHandler.errorMiddlewares)) {
                this.express.use(...this.options.errorHandler.errorMiddlewares);
            }

            this.events.emit(EventKeys.AppDidInitErrorHandler, this);
        }
    }

    protected initFormatter(): void | Promise<void> {
        require("./initializers/formatter-initializer")(this);
    }

    protected initHttpLogging(): void | Promise<void> {
        if (this.options.logging.httpLoggerEnabled) {
            if (lodash.some(this.options.logging.httpLoggerMiddlewares)) {
                this.express.use(...this.options.logging.httpLoggerMiddlewares);
            } else if (this.options.logging.httpLoggerOptions) {
                this.express.use(defaultHttpLoggerHandler(this.options.logging.httpLoggerOptions));
            }

            this.events.emit(EventKeys.AppDidInitHttpLogging, this);
        }
    }

    protected initPreIdentity(): Promise<void> {
        if (this.options.identity.enabled) {
            return require("./identity/identity-pre-initializer")(this)
        }
    }

    protected initIdentity(): void | Promise<void> {
        if (this.options.identity.enabled) {
            // won't load passport-* modules if it is not enabled;
            return require("./identity/identity-initializer")(this)
        }
    }

    protected initIndex(): void | Promise<void> {
        if (!this.options.index.enabled) {
            return
        }

        if (this.options.index.handler) {
            this.express.all("/", this.options.index.handler);
        } else if (this.options.index.filepath) {
            this.express.all("/", (res, req) => {
                req.sendFile(path.resolve(this.options.index.filepath));
            });
        } else if (this.options.index.message) {
            this.express.all("/", (res, req) => {
                req.send(this.options.index.message);
            });
        }

        this.events.emit(EventKeys.AppDidInitIndex, this);
    }

    protected initProviders(): void | Promise<void> {
        this.registerTypes(this.options.providers || []);

        this.events.emit(EventKeys.AppDidInitProviders, this);
    }

    protected initLogging(): void | Promise<void> {
        if (this.options.logging.defaultLoggerLevel) {
            FultonLog.level = this.options.logging.defaultLoggerLevel;
        }

        if (this.options.logging.defaultLoggerOptions) {
            FultonLog.configure(this.options.logging.defaultLoggerOptions);
        }

        if (this.options.logging.defaultLoggerColorized) {
            if (winston.default.transports.console) {
                (winston.default.transports.console as any).colorize = true;
            }
        }

        this.events.emit(EventKeys.AppDidInitLogging, this);
    }

    protected initMiddlewares(): void | Promise<void> {
        if (lodash.some(this.options.middlewares)) {
            this.express.use(...this.options.middlewares);

            this.events.emit(EventKeys.AppDidInitMiddlewares, this);
        }
    }

    protected async initRouters(): Promise<void> {
        let providers = this.options.routers || [];
        if (this.options.loader.routerLoaderEnabled) {
            let dirs = this.options.loader.routerDirs.map((dir) => path.join(this.options.loader.appDir, dir));
            let loadProviders = await this.options.loader.routerLoader(dirs, true) as Provider[];
            providers = loadProviders.concat(providers);
        }

        let ids = this.registerTypes(providers, true);

        this.routers = ids.map((id) => {
            let router = this.container.get<Router>(id);

            router.init(); //register router to express

            return router;
        });

        this.events.emit(EventKeys.AppDidInitRouters, this);
    }

    protected initServices(): Promise<void> {
        return require('./initializers/service-initializer')(this);
    }

    protected initStaticFile(): void | Promise<void> {
        if (this.options.staticFile.enabled) {
            if (lodash.some(this.options.staticFile.middlewares)) {
                this.options.staticFile.middlewares.forEach(opt => {
                    if (opt.path) {
                        this.express.use(opt.path, opt.middleware);
                    } else {
                        this.express.use(opt.middleware);
                    }
                });
            } else {
                this.options.staticFile.folders.forEach(opt => {
                    if (opt.path) {
                        this.express.use(opt.path, express.static(opt.folder, opt.options));
                    } else {
                        this.express.use(express.static(opt.folder, opt.options));
                    }
                })
            }

            this.events.emit(EventKeys.AppDidInitStaticFile, this);
        }
    }

    protected initServer(): void | Promise<void> {
        this.express = express();
        this.express.request.constructor.prototype.fultonApp = this;

        this.express.disable('x-powered-by');

        this.events.emit(EventKeys.AppDidInitServer, this);
    }

    protected initSecurity(): void | Promise<void> {
        if (this.options.security.enabled) {
            // won't load security module if it is not enabled;
            return require('./initializers/security-initializer')(this)
        }
    }

    /**
     * the function for di to register types
     */
    protected registerTypes(providers: Provider[], singleton?: boolean): TypeIdentifier[] {
        let ids: TypeIdentifier[] = [];

        if (providers == null)
            return ids;

        for (const provider of providers as Provider[]) {
            if (provider instanceof Function) {
                if (this.container.isBound(provider)) {
                    this.container.unbind(provider);
                }

                let binding = this.container.bind(provider as TypeProvider).toSelf();
                if (singleton == true) {
                    binding.inSingletonScope();
                }

                ids.push(provider);

                continue;
            }

            if (this.container.isBound(provider.provide)) {
                this.container.unbind(provider.provide);
            }

            if ((<ValueProvider>provider).useValue) {
                this.container.bind(provider.provide).toConstantValue((<ValueProvider>provider).useValue);
            } else if ((<ClassProvider>provider).useClass) {
                let binding = this.container.bind(provider.provide).to((<ClassProvider>provider).useClass);

                if ((<ClassProvider>provider).useSingleton == true || singleton) {
                    binding.inSingletonScope();
                }
            } else if ((<FactoryProvider>provider).useFactory) {
                this.container.bind(provider.provide).toFactory((ctx) => {
                    return (<FactoryProvider>provider).useFactory(ctx.container);
                });
            } else if ((<FunctionProvider>provider).useFunction) {
                let binding = this.container.bind(provider.provide).toDynamicValue((ctx) => {
                    return (<FunctionProvider>provider).useFunction(ctx.container);
                });

                if ((<FunctionProvider>provider).useSingleton == true || singleton) {
                    binding.inSingletonScope();
                }
            }

            ids.push(provider.provide);
        }

        return ids;
    }

    /**
     * to init the app. Env values for options will be loaded after onInit.
     * @param options the options for start app
     */
    protected abstract onInit(options: FultonAppOptions): void | Promise<void>;

    // private functions
    private serve = (req: any, res: any) => {
        this.baseUrl = Helper.baseUrlRaw(req)
        if (this.options.miscellaneous.zoneEnabled) {
            Zone.current.fork({
                name: this.appName,
                properties: { req, res },
                onHandleError: (parentZoneDelegate: ZoneDelegate, currentZone: Zone, targetZone: Zone, error: any) => {
                    this.options.errorHandler.errorMiddlewares.forEach((handler) => {
                        handler(error, req, res, null)
                    });

                    return false;
                }
            }).run(() => {
                this.express(req, res);
            });
        } else {
            this.express(req, res);
        }
    }

    private outputOptions = (message: string) => {
        return () => {
            var opt = lodash.cloneDeepWith(this.options, (value, key, o, s) => {
                if (key != null && typeof value == "object") {
                    if (value instanceof BaseOptions) {
                        return lodash.toPlainObject(value)
                    } else if (!(value instanceof Date || value instanceof Array)) {
                        return value.toString()
                    }
                }
            })

            return [message, opt]
        }
    }
}